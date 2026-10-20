/**
 * 会话首行（meta）的**定宽槽位** —— 让「改模型 / 改标题」不必碰整个文件
 *
 * ── 要解决的问题（2026-10-20 真机实测）──────────────────────
 * 开发版有个会话长到 **141 MB**（1100 条消息）。而切一次模型（只改 meta 里
 * 一个 `model` 字段）原来要走完整篇读 + 全文正则脱敏 + 整篇原子写：
 *
 *     readFileSync(全文)          1225 ms
 *     redact(整个 body) 正则       2702 ms
 *     writeAtomic(141 MB)         1880 ms
 *     ─────────────────────────────────────
 *     合计 ≈ 5.8 s（真机上 updateMeta 实测 8.7 s，含逐行解析）
 *
 * 用户感知就是「切一下模型卡 8 秒」+「软件暂时无响应」。
 *
 * ── 做法 ────────────────────────────────────────────────────
 * 把第一行（只有几百字节的标题/模型/工作目录）**补空格到固定 4096 字节**，
 * 于是改 meta 变成「在同一个偏移量上覆盖 4KB」：
 *
 *     原地覆盖首行 4KB（r+）           0 ms
 *
 * JSON 允许尾随空白，所以补空格不影响任何解析方：`JSON.parse` 照样吃，
 * `readLines` / `openLineDetailed` / 保密文的 `e1:` 前缀也全都不受影响。
 *
 * ── 三条安全边界 ────────────────────────────────────────────
 *  ① **老文件照读**：首行长度 ≠ 槽位时，调用方直接走原来的整篇路径，
 *     行为一字不变（只是下次写回时顺手升级成槽位）。
 *  ② **不是原子写，但代价可控**：整篇写会「写一半截断 → 后面全没」，
 *     而覆盖 4KB 最坏只弄坏首行 —— `readLines` 会跳过坏行、`writeMetaLine`
 *     下次发现首行不是 meta 就插一行新的，正文一个字都不丢。
 *     写入失败时**把旧首行写回去**（见 `overwriteMeta`）。
 *  ③ **坏首行会被识别**：读不到 '\n' 或解析不出 meta 一律返回 null，
 *     让调用方回退到整篇路径（避免「整个文件都坏了」被当成正常会话列出来）。
 */
const fs = require('node:fs')
const { openLineDetailed } = require('./session-crypto.cjs')
/* 「只有一份原子写」：流式写也走它，不另立一份 rename 重试 */
const { writeAtomicBy } = require('./safe-write.cjs')

/** 首行槽位宽度（字节）。几百字节的 meta 留足余量，同时小到能一次写进磁盘页 */
const META_SLOT = 4096

/**
 * 把一行补到槽位宽度（**按字节算**）。
 *
 * ★ 必须按字节：`String.length` 是 UTF-16 码元数，而文件偏移、`fs.readSync`
 *   的 length 都是**字节**。中文标题下一个 4096「字符」的行可能 5000+ 字节，
 *   于是 `readFirstLine` 在前 4097 字节里找不到换行符、一直回退到整篇路径 ——
 *   实测表现为「改完还是 8 秒」，而且不报任何错（2026-10-20 真踩）。
 *
 * 空格是 1 字节，所以补出来的总字节数正好等于 `META_SLOT`。
 * 超长时原样返回，调用方据此走整篇路径。
 */
function padToSlot(line) {
  const bytes = Buffer.byteLength(line, 'utf8')
  if (bytes >= META_SLOT) return line
  return line + ' '.repeat(META_SLOT - bytes)
}

/** 这一行占多少字节（判断「是不是正好一个槽位」用） */
function slotBytes(line) {
  return Buffer.byteLength(line, 'utf8')
}

/**
 * 只读文件**第一行**（不解密、不解析其余内容）。
 *
 * @returns {{ ok: true, line: string, size: number } | { ok: false, reason: string }}
 *   `line` 是原始首行（可能含槽位空格）；`size` 是文件总字节数。
 */
function readFirstLine(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'not-found' : 'open-failed' }
  }
  try {
    /* 比槽位多读 1 字节：正好拿到槽位后面那个 '\n' */
    const buf = Buffer.alloc(META_SLOT + 1)
    const n = fs.readSync(fd, buf, 0, META_SLOT + 1, 0)
    if (n === 0) return { ok: false, reason: 'empty' }
    const text = buf.subarray(0, n).toString('utf8')
    const cut = text.indexOf('\n')
    /* 没有换行符 = 首行超长（异常文件）或整个文件就一行 —— 都交给整篇路径判断 */
    if (cut < 0) return { ok: false, reason: 'no-newline' }
    return { ok: true, line: text.slice(0, cut), size: fs.fstatSync(fd).size }
  } catch {
    return { ok: false, reason: 'read-failed' }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 读 meta 对象（只碰首行）。**只在能安全走快路径时**返回对象，否则 null。
 *
 * 返回 null 的三种情况都要求调用方回退到整篇路径：
 *   · 首行不是槽位宽度 → 老文件
 *   · 首行解不开（换过 Windows 账户 / 文件坏了）
 *   · 解析出来不是 `type: 'meta'`
 */
function readMeta(file) {
  const got = readFirstLine(file)
  if (!got.ok) return null
  const opened = openLineDetailed(got.line.trim())
  if (!opened.ok) return null
  try {
    const obj = JSON.parse(opened.text)
    if (!obj || obj.type !== 'meta') return null
    /* `line` 原样带回去：覆盖失败时要用它回滚 */
    return { meta: obj, size: got.size, line: got.line, slotted: slotBytes(got.line) === META_SLOT }
  } catch {
    return null
  }
}

/**
 * 老文件**升级成槽位首行**：流式换首行，正文原样字节拷贝。
 *
 * ── 为什么不能整篇读 ────────────────────────────────────────
 * 升级要把 227 字节的首行扩成 4096 字节，后面所有字节都得往后挪 ——
 * 所以躲不掉「写一遍整个文件」。但**读**可以省：
 * 以前的整篇路径 `readFileSync` 把 141 MB 全进内存、再对全文跑一遍正则、
 * 再 `writeFileSync`，实测 20 秒、内存峰值近 1 GB。
 * 这里改成 1 MB 一块地读 → 写，内存只占一块。
 *
 * ── 密钥清理这条保证怎么保住 ────────────────────────────────
 * 「改 meta 时顺手清掉旧文件里的明文密钥」是自检 `31-session-redact` 钉着的。
 * 做法：**先分块扫一遍**（只找特征串，不做替换）。
 *   · 没找到 → 正文里没有明文密钥，流式拷贝即可（最常见的路径，快）
 *   · 找到了 → 返回 `needsFull`，调用方退回整篇路径做完整逐行脱敏（慢但安全）
 * 检测用的是 `redact.cjs` 那套模式的特征前缀，宁可多判（多判只是慢一次）。
 *
 * @returns {{ ok: boolean, needsFull?: boolean, error?: string }}
 */
function upgradeSlotStreaming(file, nextLine) {
  if (slotBytes(nextLine) !== META_SLOT) return { ok: false, needsFull: true }
  let fdIn
  try {
    fdIn = fs.openSync(file, 'r')
    /* 跳过旧首行：找到第一个 '\n' 的偏移，从它后面开始拷 */
    const skip = firstNewlineOffset(fdIn)
    if (skip < 0) return { ok: false, needsFull: true }
    const source = fdIn
    let foundSecret = false
    writeAtomicBy(file, (tmp) => {
      const fdOut = fs.openSync(tmp, 'w')
      try {
        /* ① 新首行（含换行） */
        fs.writeSync(fdOut, Buffer.from(`${nextLine}\n`, 'utf8'))
        /* ② 一遍过：读一块 → 扫密钥特征 → 原样写出（不整篇进内存） */
        const CHUNK = 1024 * 1024
        /* 多留 32 字节重叠：特征串可能正好跨块边界 */
        const OVERLAP = 32
        const buf = Buffer.alloc(CHUNK + OVERLAP)
        let pos = skip
        let carryLen = 0
        for (;;) {
          const n = fs.readSync(source, buf, carryLen, CHUNK, pos)
          if (n <= 0) break
          const view = buf.subarray(0, carryLen + n)
          if (!foundSecret && hasMarker(view)) foundSecret = true
          /*
           * ★ 只写**本次新读到的**那段（2026-10-20 修）。
           *
           * `view` 的头 `carryLen` 字节是上一块的尾巴副本（为了跨块查特征串
           * 才留在开头），上一轮**已经写出去过了**。整段 `view` 写出去就会
           * 每块重复 32 字节 —— 真机上表现为「会话有 6 行解不开、消息从 1100
           * 变成 1097」，也就是数据被写坏。
           */
          fs.writeSync(fdOut, view.subarray(carryLen))
          /* 把尾巴留到下一块开头，避免跨块漏判 */
          carryLen = Math.min(OVERLAP, view.length)
          view.copy(buf, 0, view.length - carryLen)
          pos += n
        }
      } finally {
        fs.closeSync(fdOut)
      }
      /*
       * ★ 必须**在 rename 之前**放掉源文件句柄（2026-10-20 真机踩到）。
       *
       * `writeAtomicBy` 写完 tmp 就 `rename(tmp → file)`，而 Windows 上
       * **rename 到一个还被打开的源文件会直接返回 EPERM**（Node 的 `'r'` 打开
       * 不带 FILE_SHARE_DELETE）。那时 5 次退避重试全是同一个错，最终退回
       * 「整篇读 + 全文正则 + 整篇写」—— 141 MB 的会话就白等 7.8 秒。
       *
       * 顺序改对了就快：拷贝期间源句柄在、rename 之前关掉。
       */
      fs.closeSync(source)
      fdIn = undefined
    })
    /* 扫到了明文密钥特征 → 必须退回整篇路径做逐行脱敏，不能就这么落盘 */
    if (foundSecret) return { ok: false, needsFull: true }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `升级首行失败：${error?.message ?? error}` }
  } finally {
    if (fdIn !== undefined) {
      try {
        fs.closeSync(fdIn)
      } catch {
        /* 已经关了 */
      }
    }
  }
}

/** 第一个 '\n' 的字节偏移；找不到返回 -1 */
function firstNewlineOffset(fd) {
  const CHUNK = 64 * 1024
  const buf = Buffer.alloc(CHUNK)
  let pos = 0
  for (;;) {
    const n = fs.readSync(fd, buf, 0, CHUNK, pos)
    if (n <= 0) return -1
    const at = buf.subarray(0, n).indexOf(0x0a)
    if (at >= 0) return pos + at + 1
    pos += n
  }
}

/**
 * 正文里有没有明文密钥的**特征串**（只判断，不替换）。
 *
 * 命中就往整篇路径走 —— 代价是慢一次，但绝不会把旧密钥漏在盘上。
 * 这些前缀取自 `redact.cjs` 的模式表；判宽一点没坏处。
 *
 * ★ 用 Buffer 直接在字节上找（marker 全是 ASCII）：141 MB 逐块 `toString`
 *   再 `includes` 要 2 秒多，字节匹配是它的十分之一。
 */
const SECRET_MARKERS = [
  'Bearer ',
  'Basic ',
  'PRIVATE KEY',
  'sk-',
  'ghp_',
  'github_pat_',
  'AIza',
  'AKIA',
  'hf_',
  'xoxb-',
  'xoxp-',
  'eyJ',
].map((marker) => Buffer.from(marker, 'utf8'))

function hasMarker(view) {
  for (const marker of SECRET_MARKERS) {
    if (view.indexOf(marker) >= 0) return true
  }
  return false
}

/**
 * 在**原偏移量**上覆盖首行（不动其余字节）。
 *
 * 写完把文件指针留在原处不重要 —— 调用方只关心「首行换了、正文没动」。
 * 失败时尝试把旧内容写回去：宁可恢复旧 meta，也不要留下半行坏 JSON。
 *
 * @returns {{ ok: boolean, error?: string }}
 */
function overwriteMeta(file, previousLine, nextLine) {
  if (slotBytes(nextLine) !== META_SLOT) return { ok: false, error: 'meta 超过槽位宽度' }
  let fd
  try {
    fd = fs.openSync(file, 'r+')
  } catch (error) {
    return { ok: false, error: `打不开会话文件：${error?.message ?? error}` }
  }
  try {
    const buf = Buffer.from(nextLine, 'utf8')
    fs.writeSync(fd, buf, 0, META_SLOT, 0)
    return { ok: true }
  } catch (error) {
    /* 回滚：把读到的旧首行原样写回（字节宽度相同，偏移相同） */
    try {
      const back = Buffer.from(previousLine, 'utf8')
      if (back.length === META_SLOT) fs.writeSync(fd, back, 0, META_SLOT, 0)
    } catch {
      /* 回滚也失败就只能如实上报，不假装成功 */
    }
    return { ok: false, error: `覆盖 meta 失败：${error?.message ?? error}` }
  } finally {
    fs.closeSync(fd)
  }
}

module.exports = {
  META_SLOT,
  padToSlot,
  slotBytes,
  readFirstLine,
  readMeta,
  overwriteMeta,
  upgradeSlotStreaming,
}
