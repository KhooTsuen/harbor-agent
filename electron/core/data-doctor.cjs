/**
 * 数据体检（Data Doctor）—— 把 `data/` 里「对不上的地方」列出来
 *
 * 为什么要有：长期用下来，磁盘上的东西是**互相指来指去**的 ——
 * 任务指向会话、改动事务指向任务、成果的每一版是一个单独的文件。
 * 任何一处对不上（写了一半崩了、手动删过文件、老版本留下的形状），
 * 现在都**没有任何地方会告诉你**：功能照常跑，坏的那条静静躺着。
 *
 * 三条刻意的设计约束：
 *   ① **只读**。不修、不删、不改、不建任何文件 —— 自检里钉着
 *      「跑一遍前后 data 一个字节不变」。要修是人的决定，不是体检的职权。
 *   ② **分两级，因为两类问题的性质不同**：
 *      `error` = 内部对不上（清单里记着的文件不见了、JSON 读不动、索引漂移）——
 *                 这些是**真出事了**，正常使用不会产生；
 *      `warn`  = 跨实体的悬空引用 —— 删任务/删对话**本来就会**留下它们
 *                （`task-io.remove` 只删任务文件，事务和成果都留着），
 *                 所以它们是「可以清的垃圾」，不是「坏掉的数据」。
 *      把这两类混在一起报，用户第一次跑就会被吓一跳，然后就不看了。
 *   ③ **读不动的当问题报出来，不当崩溃**。坏 JSON 本身就是最该报的那类问题；
 *      它一抛错，整份体检就只剩这一条。
 *
 * 刻意不 require('electron')：自检直接跑，也能在 CI 上跑。
 *
 * ── 拆过一次（2026-09-30，beta.35）──
 * 检查逻辑 + 报告渲染写在一个文件里，加完就 358 行，顶穿硬约束 #2。
 * 缝在「查什么」和「怎么说是两件事」：**报告层（LABELS / format）搬去了
 * `data-doctor-report.cjs`**，这边只留读目录、比清单、认坏 JSON。
 * 搬出去之后这里 re-export，调用方（`scripts/data-doctor.mjs` / 自检 94 组）一行没改。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
/* 报告层在单独一个文件里（为什么这么拆见 data-doctor-report.cjs 的文件头）；这里 re-export */
const { LABELS, MAX_PER_KIND, format } = require('./data-doctor-report.cjs')

/** 会话只看尾巴这么多字节 —— 几 MB 的会话不该整篇读进来 */
const TAIL_BYTES = 64 * 1024

const isDir = (dir) => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

const exists = (file) => {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

/** 目录下的条目名（排过序，报告才稳定） */
const names = (dir, test = () => true) => {
  try {
    return fs.readdirSync(dir).filter(test).sort()
  } catch {
    return []
  }
}

/** 读 JSON：**不抛错**，把「读不动」本身当成结果 */
function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 会话文件的最后一行（空串 = 没读到 / 读不准，调用方跳过检查）。
 *
 * 只看尾巴：一张带图的消息能有几百 KB，为了查「最后一行完不完整」把整篇读进内存不值当。
 * 尾巴从中间切开时，第一条多半是半截 —— 丢掉它；整段只有一个换行时干脆不判，
 * **宁可漏报也不误报**（误报会让人不再信任这份报告）。
 */
function tailLine(file) {
  try {
    const size = fs.statSync(file).size
    if (size === 0) return ''
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buf, 0, buf.length, start)
    } finally {
      fs.closeSync(fd)
    }
    const text = buf.toString('utf8')
    const all = text.split(/\r?\n/)
    const lines = (start > 0 ? all.slice(1) : all).map((line) => line.trim()).filter(Boolean)
    return lines[lines.length - 1] ?? ''
  } catch {
    return ''
  }
}

/** 会话行的密文前缀（加密开着时，行不是 JSON —— 见 session-crypto.cjs） */
function encryptedPrefix() {
  try {
    return require('./session-crypto.cjs').PREFIX
  } catch {
    return 'e1:'
  }
}

/**
 * 扫一遍。
 *
 * @param {{ root?: string }} [options] `root` 默认 `data/`；自检传一个临时目录
 * @returns {{ ok: boolean, at: number, root: string, counts: object,
 *             problems: Array<{level: string, kind: string, label: string, detail: string, hint: string}>,
 *             totals: Record<string, number>, kinds: Array, truncated: boolean }}
 */
function run(options = {}) {
  const root = String(options.root ?? DIRS.data)
  const dirs = {
    tasks: path.join(root, 'tasks'),
    sessions: path.join(root, 'sessions'),
    changesets: path.join(root, 'changesets'),
    artifacts: path.join(root, 'artifacts'),
  }
  const problems = []
  /* kind → 总数（不管列不列明细，数字都算全）；kind → 已列几条；kind → 级别 */
  const totals = {}
  const listed = {}
  const levels = {}
  /**
   * 记一笔。
   *
   * `detail` 只写「是哪一条」（id 之类），**不重写一遍结论** ——
   * 结论来自 `LABELS[kind]`，一处定义。第一版把整句话塞进 detail，
   * 结果报告里「例：」那行变成三句同款话叠在一起。
   * `hint` 是给这一类加的一句解释（可选，只在第一条上留）。
   */
  const add = (level, kind, detail = '', hint = '') => {
    totals[kind] = (totals[kind] ?? 0) + 1
    levels[kind] = level
    if ((listed[kind] ?? 0) >= MAX_PER_KIND) return
    listed[kind] = (listed[kind] ?? 0) + 1
    problems.push({ level, kind, label: LABELS[kind] ?? kind, detail, hint })
  }

  /* ── 任务：读得动吗 / 它指着的会话还在吗 ── */
  const taskIds = new Set()
  for (const name of names(dirs.tasks, (n) => n.endsWith('.json') && !n.startsWith('_'))) {
    const file = path.join(dirs.tasks, name)
    const parsed = readJson(file)
    if (!parsed.ok) {
      add('error', 'task_json_broken', `${name} —— ${parsed.error}`)
      continue
    }
    const task = parsed.value ?? {}
    const id = String(task.id ?? name.replace(/\.json$/, ''))
    taskIds.add(id)
    const sessionId = String(task.sessionId ?? '')
    if (sessionId && !exists(path.join(dirs.sessions, `${sessionId}.jsonl`))) {
      add('warn', 'task_session_missing', `${id} · 会话 ${sessionId}`)
    }
  }

  /* ── 会话：尾巴是不是写坏的（崩在写入中途会留半行） ── */
  const sessionFiles = names(dirs.sessions, (n) => n.endsWith('.jsonl'))
  const prefix = encryptedPrefix()
  for (const name of sessionFiles) {
    const last = tailLine(path.join(dirs.sessions, name))
    if (!last || last.startsWith(prefix)) continue
    try {
      JSON.parse(last)
    } catch {
      add(
        'error',
        'session_tail_broken',
        name,
        '写入被打断留下的半行；读取时会跳过它，前面的内容没丢',
      )
    }
  }

  /* ── 改动事务：清单里记着的快照文件在不在 ── */
  const changesetIds = new Set()
  for (const id of names(dirs.changesets, (n) => isDir(path.join(dirs.changesets, n)))) {
    const metaFile = path.join(dirs.changesets, id, 'meta.json')
    if (!exists(metaFile)) {
      add('error', 'changeset_no_meta', id, '目录在、清单不在')
      continue
    }
    const parsed = readJson(metaFile)
    if (!parsed.ok) {
      add('error', 'changeset_meta_broken', `${id} —— ${parsed.error}`)
      continue
    }
    const meta = parsed.value ?? {}
    changesetIds.add(String(meta.id ?? id))
    for (const entry of Array.isArray(meta.files) ? meta.files : []) {
      if (!entry?.snap) continue
      const snap = path.join(dirs.changesets, id, 'files', String(entry.snap))
      if (!exists(snap)) {
        add('error', 'changeset_snapshot_missing', `${id} · ${String(entry.snap)}`)
      }
    }
    const taskId = String(meta.taskId ?? '')
    if (taskId && !taskIds.has(taskId)) {
      add('warn', 'changeset_task_missing', `${id} · 任务 ${taskId}`)
    }
  }

  /* ── 成果：每一版是一个单独文件，缺了就真缺了 ── */
  for (const id of names(dirs.artifacts, (n) => isDir(path.join(dirs.artifacts, n)))) {
    const metaFile = path.join(dirs.artifacts, id, 'meta.json')
    if (!exists(metaFile)) {
      add('error', 'artifact_no_meta', id, '目录在、清单不在')
      continue
    }
    const parsed = readJson(metaFile)
    if (!parsed.ok) {
      add('error', 'artifact_meta_broken', `${id} —— ${parsed.error}`)
      continue
    }
    const meta = parsed.value ?? {}
    for (const version of Array.isArray(meta.versions) ? meta.versions : []) {
      const body = path.join(dirs.artifacts, id, `v${Number(version?.version)}.md`)
      if (!exists(body)) {
        add(
          'error',
          'artifact_version_missing',
          `${id} · 第 ${Number(version?.version)} 版`,
          '清单里记着它，磁盘上没有',
        )
      }
    }
    const taskId = String(meta.taskId ?? '')
    const sessionId = String(meta.sessionId ?? '')
    if (taskId && !taskIds.has(taskId) && (!sessionId || !exists(path.join(dirs.sessions, `${sessionId}.jsonl`)))) {
      add('warn', 'artifact_scope_missing', `${id} · 任务 ${taskId} · 会话 ${sessionId || '（无）'}`)
    }
  }

  /* ── 任务索引：它只是加速、不是真相源，但**对不上就该重建** ── */
  const indexFile = path.join(dirs.tasks, '_index.json')
  let indexItems = 0
  if (exists(indexFile)) {
    const parsed = readJson(indexFile)
    if (!parsed.ok) {
      add('error', 'index_broken', parsed.error, '下次列任务会自动重建')
    } else {
      const items = Array.isArray(parsed.value?.items) ? parsed.value.items : []
      indexItems = items.length
      const inIndex = new Set(items.map((item) => String(item?.id ?? '')))
      const missing = [...taskIds].filter((id) => !inIndex.has(id))
      const stale = [...inIndex].filter((id) => id && !taskIds.has(id))
      if (missing.length > 0 || stale.length > 0) {
        add(
          'error',
          'index_drift',
          `索引 ${items.length} 条 / 磁盘 ${taskIds.size} 条；索引少 ${missing.length} 条、多 ${stale.length} 条`,
          '列任务时会自动重建，不用管',
        )
      }
    }
  }

  const errorKinds = Object.keys(totals).filter((kind) => levels[kind] === 'error')
  const totalErrors = errorKinds.reduce((sum, kind) => sum + totals[kind], 0)
  const totalAll = Object.values(totals).reduce((sum, n) => sum + n, 0)
  return {
    ok: totalErrors === 0,
    at: Date.now(),
    root,
    counts: {
      tasks: taskIds.size,
      sessions: sessionFiles.length,
      changesets: changesetIds.size,
      artifacts: names(dirs.artifacts, (n) => isDir(path.join(dirs.artifacts, n))).length,
      indexItems,
      errors: totalErrors,
      warnings: totalAll - totalErrors,
    },
    problems,
    totals,
    kinds: Object.keys(totals).map((kind) => ({
      kind,
      label: LABELS[kind] ?? kind,
      level: levels[kind] ?? 'warn',
      count: totals[kind],
    })),
    truncated: totals && Object.entries(totals).some(([kind, n]) => n > (listed[kind] ?? 0)),
  }
}

/* 报告层的 `format` 在这里 re-export —— 调用方只认这个模块 */
module.exports = { run, format, LABELS, MAX_PER_KIND }
