/**
 * 数据目录迁移：**只读的那一半**（检查 + 校验）
 *
 * 从 `data-migrate.cjs` 拆出来的 —— 那边加完执行流程到了 365 行（硬约束 #2 是 300）。
 * 按职责切：这边**一个字节都不写**（除了 `writable()` 里那个探针文件，写完立刻删），
 * 那边只管"真搬"。判据与理由全在这边，执行那边只负责按顺序调。
 *
 * ── 为什么检查要这么细 ────────────────────────────────────────
 *
 * 迁移是**不可逆操作里最接近"搬家"**的那一类：搬一半断电，用户看到的是两处
 * 都不完整。所以能提前查出来的，一律在动手之前查完，绝不留到"拷到一半才发现"。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 目标目录里的迁移状态文件（复制前写，校验时排除它） */
const STATE_NAME = '.harbor-migrate.json'

/** 抽样比对取多少字节 —— 只用来发现"复制了一半"，不追求全量摘要 */
const SAMPLE_BYTES = 64 * 1024
/** 小于这个大小的文件全量比对 —— 小文件占绝大多数，全比也不慢 */
const FULL_HASH_MAX = 512 * 1024

/** `a` 是不是 `b` 的同一路径或子路径（大小写不敏感，Windows） */
function inside(a, b) {
  const x = path.resolve(a).toLowerCase()
  const y = path.resolve(b).toLowerCase()
  return x === y || x.startsWith(`${y}${path.sep}`)
}

/** 目录里所有文件的相对路径与大小（跳过状态文件本身） */
function walk(dir, base = dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, base, out)
      continue
    }
    if (entry.name === STATE_NAME) continue
    try {
      out.push({ rel: path.relative(base, full), size: fs.statSync(full).size })
    } catch {
      /* 读不到就当不存在 —— 校验那一步会把它算成"缺" */
    }
  }
  return out
}

/** 目录占用（字节） */
function dirSize(dir) {
  return walk(dir).reduce((sum, item) => sum + item.size, 0)
}

/** 目标盘的可用空间（字节）；拿不到返回 null（不猜成 0，0 会被当成"空间不足"） */
function freeBytes(dir) {
  try {
    /* Node ≥18.15 才有 statfsSync；老环境拿不到就跳过空间检查 */
    const st = fs.statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

/** 这个目录可写吗（真写一个临时文件再删，不看权限位） */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, 'x', 'utf8')
    fs.rmSync(probe, { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 读目标目录里的迁移状态（没有 / 坏了都返回 null） */
function readState(to) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(to, STATE_NAME), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 只检查，一个字节都不动。
 *
 * @param {{ from: string, to: string }} input
 * @returns {{ ok: boolean, blockers: Array<{ code: string, text: string }>,
 *             from: string, to: string, files: number, bytes: number, free: number|null,
 *             resume: boolean }}
 */
function inspect(input) {
  const src = String(input?.from ?? '').trim()
  const dst = String(input?.to ?? '').trim()
  const blockers = []
  const add = (code, text) => blockers.push({ code, text })

  if (!src || !dst) add('empty', '源目录和目标目录都得给')
  if (src && !path.isAbsolute(src)) add('relative', '源目录必须是绝对路径')
  if (dst && !path.isAbsolute(dst)) add('relative', '目标目录必须是绝对路径')

  const srcOk = Boolean(src) && path.isAbsolute(src) && fs.existsSync(src) && fs.statSync(src).isDirectory()
  if (!srcOk) add('src_missing', `找不到当前数据目录：${src || '（空）'}`)

  if (src && dst && path.isAbsolute(src) && path.isAbsolute(dst)) {
    if (inside(dst, src)) add('overlap', '目标目录在源目录里面（会一边拷一边变）')
    else if (inside(src, dst)) add('overlap', '源目录在目标目录里面（同上）')
  }

  /* ★ C 盘硬约束：Harbor 的数据不落系统盘，这是 AGENT.md 第 3 条。
     用户可以在 D/E/F 里随便挑，但不能挑 C —— 这条不给配置开口子。 */
  if (dst && fs.existsSync(path.dirname(path.resolve(dst)))) {
    if (path.resolve(dst).toLowerCase().startsWith('c:\\')) {
      add('c_drive', 'Harbor 的数据不落 C 盘（硬规则）；请选 D 盘或其它磁盘')
    }
  }

  /* 目标已经有东西？三种情况放行，其余拒绝 —— 绝不覆盖别人的数据 */
  let resume = false
  if (dst && srcOk && fs.existsSync(dst)) {
    const state = readState(dst)
    const entries = fs.readdirSync(dst).filter((name) => name !== STATE_NAME)
    if (entries.length === 0) {
      /* 空目录：可以迁 */
    } else if (
      state &&
      state.from &&
      path.resolve(String(state.from)) === path.resolve(src) &&
      state.phase !== 'done'
    ) {
      /* 上次没迁完、源还是同一个 → 允许清掉半成品重来（删的是我自己刚拷的） */
      resume = true
    } else {
      add('not_empty', `目标目录里已经有东西了（${entries.length} 项）。为了不覆盖你的数据，换个空目录`)
    }
  }

  const parent = dst && path.isAbsolute(dst) ? path.dirname(dst) : ''
  if (parent) {
    const w = writable(parent)
    if (!w.ok) add('not_writable', `目标位置写不进去：${w.error}`)
  }

  const bytes = srcOk ? dirSize(src) : 0
  const free = parent && fs.existsSync(parent) ? freeBytes(parent) : null
  if (free !== null && bytes > 0 && free < bytes * 1.1) {
    const need = Math.ceil(bytes / 1024 / 1024)
    const have = Math.floor(free / 1024 / 1024)
    add('no_space', `空间不够：要 ${need}MB，目标盘只剩 ${have}MB`)
  }

  return {
    ok: blockers.length === 0,
    blockers,
    from: src,
    to: dst,
    files: srcOk ? walk(src).length : 0,
    bytes,
    free,
    resume,
  }
}

/** 抽样比对内容：小文件全比，大文件比头 64KB —— 目的是发现"拷了一半" */
function sameContent(a, b) {
  let sizeA = 0
  try {
    sizeA = fs.statSync(a).size
  } catch {
    return false
  }
  const take = sizeA <= FULL_HASH_MAX ? sizeA : SAMPLE_BYTES
  const head = (file) => {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(take)
      const got = fs.readSync(fd, buf, 0, take, 0)
      return buf.subarray(0, got)
    } finally {
      fs.closeSync(fd)
    }
  }
  try {
    return Buffer.compare(head(a), head(b)) === 0
  } catch {
    return false
  }
}

/**
 * 校验：文件数一致 + 每个文件大小一致 + 抽样内容一致。
 *
 * ★ 为什么不能只看"复制命令没报错"：`fs.cpSync` 在磁盘满、进程被杀、
 *   杀毒软件锁文件时都可能"部分完成"。那时用户看到的是"迁移成功"，实际少了文件。
 */
function verify(from, to) {
  const srcList = walk(from)
  const dstList = walk(to)
  const dstMap = new Map(dstList.map((item) => [item.rel, item.size]))

  const missing = []
  const sized = []
  for (const item of srcList) {
    if (!dstMap.has(item.rel)) {
      missing.push(item.rel)
      continue
    }
    if (dstMap.get(item.rel) !== item.size) sized.push(item.rel)
  }
  if (missing.length > 0 || sized.length > 0) {
    return {
      ok: false,
      error: `复制不完整：缺 ${missing.length} 个、大小不符 ${sized.length} 个`,
      missing: missing.slice(0, 20),
      sized: sized.slice(0, 20),
      files: srcList.length,
      copied: dstList.length,
    }
  }

  /* 抽样：最近修改的 12 个 + 最大的 8 个（最可能出问题的两类） */
  const byMtime = [...srcList]
    .map((item) => {
      let mtime = 0
      try {
        mtime = fs.statSync(path.join(from, item.rel)).mtimeMs
      } catch {
        /* 读不到就排最后 */
      }
      return { ...item, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 12)
  const bySize = [...srcList].sort((a, b) => b.size - a.size).slice(0, 8)
  const sample = [...new Map([...byMtime, ...bySize].map((item) => [item.rel, item])).values()]

  const bad = sample.filter((item) => !sameContent(path.join(from, item.rel), path.join(to, item.rel)))
  if (bad.length > 0) {
    return { ok: false, error: `抽样内容对不上：${bad.length} 个`, bad: bad.slice(0, 10).map((i) => i.rel) }
  }

  return { ok: true, files: srcList.length, copied: dstList.length, sampled: sample.length }
}

module.exports = { STATE_NAME, inside, walk, dirSize, freeBytes, writable, readState, inspect, verify }
