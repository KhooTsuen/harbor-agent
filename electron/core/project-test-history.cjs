/**
 * 项目测试的**执行结果快照**（2026-10-17 · 3B-1）
 *
 * ── 它解决什么 ────────────────────────────────────────────────
 *
 * 3B-1 要求「分析**已有**测试结果，不得重新执行项目测试」（B11）。
 * 但 3A 的执行结果只活在那一轮对话的正文里 —— 模型要分析它，就得再跑一次。
 * 这里把每次执行的**有界、脱敏**快照留下来，分析层按 `executionId` 取。
 *
 * ── ★ 四条不变量 ──────────────────────────────────────────────
 *
 *   ① **有界**：输出最多 `MAX_OUTPUT` 字符，条数最多 `MAX_ITEMS`（环形裁剪）。
 *      快照是给"事后看一眼"的，不是日志归档 —— 不能把磁盘吃光。
 *   ② **脱敏**：输出先过 `redact.scrub`。测试输出里可能带 token / 绝对用户路径。
 *   ③ **不可伪造**：`record()` 只由执行段调用；分析层只按 id 查，**不接受**
 *      调用方自己声明"这是一次 FAIL"。快照里的 status 来自 `classifyRun`。
 *   ④ **落盘只在 data/**：`DIRS.data/project-test-runs.jsonl`（硬约束 3）。
 *
 * ── 为什么存 JSONL 而不是 JSON ────────────────────────────────
 *
 * 追加写不会因为一次崩溃毁掉整份历史；读取时逐行 JSON.parse，坏行跳过
 * （磁盘写到一半是真实会发生的）。环形裁剪用"重写一次"实现，频率很低。
 *
 * ⚠️ 不 require electron。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 单条快照里输出最多留多少字符（远超界面需要，但远小于把磁盘吃光） */
const MAX_OUTPUT = 16_000
/** 两种测试各自最多留几条（项目测试 / 常量测试共用同一份历史） */
const MAX_ITEMS = 200
/** 读历史时最多回看多少行（防御畸形文件撑爆内存） */
const MAX_SCAN_LINES = 2000

/** 快照文件（读 `DIRS.data` 时**惰性**取：模块加载时 paths 可能还没初始化） */
function file() {
  const { DIRS } = require('./paths.cjs')
  return path.join(DIRS.data, 'project-test-runs.jsonl')
}

/** 造一个不会被猜到的执行 id */
function newExecutionId(ts = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8)
  return `ptr_${ts.toString(36)}_${rand}`
}

/** 脱敏（失败也不影响主流程：拿不到 scrub 就原样返回，绝不因此丢快照） */
function safeScrub(text) {
  try {
    return require('./redact.cjs').scrub(String(text ?? ''))
  } catch {
    return String(text ?? '')
  }
}

/** 有界：超了保留头尾（和 `tools/index.limitOutput` 同思路，中间省略） */
function clampText(text, max = MAX_OUTPUT) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${s.slice(0, head)}\n\n…（快照省略 ${s.length - max} 字符）…\n\n${s.slice(-tail)}`
}

/**
 * 记一条执行快照。
 *
 * ★ **只由执行段调用**。分析层没有写入口 —— 这是 B14（伪造不能产生被信任结果）
 *   的第一道结构性保证：调用方给不出 status，只能给 id。
 *
 * @param {object} input
 * @param {string} [input.testId]
 * @param {string} [input.label]
 * @param {'project'|'constant'} [input.kind] 项目测试 / 常量测试
 * @param {string} [input.projectRoot]
 * @param {string} [input.command]
 * @param {string} [input.status] 六态之一（**来自 classifyRun，不是调用方声明**）
 * @param {number|null} [input.exitCode]
 * @param {number} [input.ms]
 * @param {boolean|null} [input.approved]
 * @param {string} [input.output] 原始输出（这里才脱敏 + 截断）
 * @returns {object} 落盘的快照（不含 output 的原始形态，便于调用方回传 id）
 */
function record(input = {}) {
  const snap = {
    executionId: newExecutionId(),
    at: new Date().toISOString(),
    kind: input.kind === 'constant' ? 'constant' : 'project',
    testId: String(input.testId ?? ''),
    label: clampText(input.label ?? '', 200),
    projectRoot: clampText(input.projectRoot ?? '', 500),
    command: clampText(input.command ?? '', 300),
    status: String(input.status ?? ''),
    exitCode: input.exitCode === null || input.exitCode === undefined ? null : Number(input.exitCode),
    ms: Number.isFinite(Number(input.ms)) ? Number(input.ms) : null,
    approved: input.approved === true ? true : input.approved === false ? false : null,
    outputBytes: Buffer.byteLength(String(input.output ?? '')),
    outputTruncated: String(input.output ?? '').length > MAX_OUTPUT,
    output: clampText(safeScrub(input.output)),
  }

  try {
    const target = file()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.appendFileSync(target, `${JSON.stringify(snap)}\n`, 'utf8')
    trimIfNeeded(target)
  } catch {
    /* 写不进去不影响这次测试的结果 —— 只是事后分析少一条 */
  }
  /* 回给调用方的只要这些（output 太大，不回） */
  return {
    executionId: snap.executionId,
    testId: snap.testId,
    status: snap.status,
    at: snap.at,
    outputTruncated: snap.outputTruncated,
  }
}

/** 超过上限就重写一份（保留最后 MAX_ITEMS 条） */
function trimIfNeeded(target) {
  try {
    const text = fs.readFileSync(target, 'utf8')
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length <= MAX_ITEMS) return
    fs.writeFileSync(target, `${lines.slice(-MAX_ITEMS).join('\n')}\n`, 'utf8')
  } catch {
    /* 裁剪失败不算错误，下次再试 */
  }
}

/**
 * 读全部快照（坏行跳过）。
 * @returns {object[]}
 */
function all() {
  let text = ''
  try {
    text = fs.readFileSync(file(), 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter((l) => l.trim())
  const out = []
  for (const line of lines.slice(-MAX_SCAN_LINES)) {
    try {
      const one = JSON.parse(line)
      if (one && typeof one === 'object' && one.executionId) out.push(one)
    } catch {
      /* 坏行跳过 —— 写到一半的行是真实会发生的 */
    }
  }
  return out
}

/**
 * 按执行 id 取一条。
 * @param {unknown} executionId
 * @returns {object|null}
 */
function get(executionId) {
  const id = String(executionId ?? '').trim()
  if (!id) return null
  return all().find((x) => x.executionId === id) ?? null
}

/**
 * 某个测试条目最近一次执行。
 * @param {unknown} testId
 * @returns {object|null}
 */
function latest(testId) {
  const id = String(testId ?? '').trim()
  if (!id) return null
  const list = all().filter((x) => x.testId === id)
  return list.length > 0 ? list[list.length - 1] : null
}

/** 摘要列表（给「不给 id 时列可选项」用；不含 output） */
function listRecent(limit = 10) {
  return all()
    .slice(-Math.max(1, limit))
    .reverse()
    .map((x) => ({
      executionId: x.executionId,
      testId: x.testId,
      label: x.label,
      status: x.status,
      at: x.at,
      kind: x.kind,
    }))
}

module.exports = { MAX_OUTPUT, MAX_ITEMS, record, get, latest, all, listRecent, file, newExecutionId }
