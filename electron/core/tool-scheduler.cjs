/**
 * 工具调度（token 优化 · 阶段 2）
 *
 * 三件事，全是纯函数 / 轻 IO，便于自检：
 *   ① planBatches —— 把一轮的 tool_calls 切成批次：
 *        连续「无依赖只读」且目标不同 → 同一批（可并行）；
 *        其余（写、同目标、非只读）→ 单独一批（串行，保持顺序）。
 *   ② snapshotTargets / partialResultOf —— 写操作前后文件 hash 对比，
 *        用来做「部分成功检测」：写坏了但文件已经变了 → 重试前必须先看现场。
 *   ③ argsHash —— 同任务里「重复调用」的判据（同名同参）。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')

/* 只读、无副作用工具 —— 并行白名单（与 errors.cjs 的 READONLY_TOOLS 同一口径） */
const READONLY = new Set(['read_file', 'list_dir', 'search_web', 'browse', 'browse_elements'])

const sha = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12)

function isReadonly(name) {
  return READONLY.has(String(name ?? ''))
}

/** 同任务内「同工具同参数」的指纹 */
function argsHash(name, args) {
  try {
    return sha(`${name}|${JSON.stringify(args ?? {})}`)
  } catch {
    return ''
  }
}

/**
 * 批次规划。
 *
 * @param {Array<{id:string,name:string,args:object}>} calls
 * @param {{ target?: (call: object) => string }} [options] 目标（比如文件路径）
 * @returns {Array<Array>} 批次数组：每批内可并行，批与批之间串行
 */
function planBatches(calls, { target = defaultTarget } = {}) {
  const batches = []
  let current = []
  let seen = new Set()

  const flush = () => {
    if (current.length > 0) {
      batches.push(current)
      current = []
      seen = new Set()
    }
  }

  for (const call of calls ?? []) {
    if (!isReadonly(call?.name)) {
      flush()
      batches.push([call])
      continue
    }
    const key = target(call)
    /* 同一目标重复出现（哪怕同批两次读同一文件）→ 拆开，别让两次读并发到同一文件句柄语义里 */
    if (key && seen.has(key)) flush()
    current.push(call)
    if (key) seen.add(key)
  }
  flush()
  return batches
}

function defaultTarget(call) {
  const args = call?.args ?? {}
  if (typeof args.path === 'string') return `path:${args.path}`
  if (typeof args.dir === 'string') return `dir:${args.dir}`
  return ''
}

const fileHash = (file) => {
  try {
    return sha(fs.readFileSync(file))
  } catch {
    return null
  }
}

/**
 * 写操作前的快照（只覆盖 write_file / edit_file；其余格式原样返回空）。
 *
 * @param {Array} calls
 * @param {{ resolve?: (p: string) => string }} [options]
 */
function snapshotTargets(calls, { resolve = (p) => p } = {}) {
  const snap = {}
  for (const call of calls ?? []) {
    if (call?.name !== 'write_file' && call?.name !== 'edit_file') continue
    const raw = call?.args?.path
    if (typeof raw !== 'string' || !raw) continue
    try {
      const abs = resolve(raw)
      snap[call.id] = { path: abs, before: fileHash(abs) }
    } catch {
      /* 路径解析失败留空：拿不到快照就不做部分成功判断 */
    }
  }
  return snap
}

/**
 * 失败之后：这个写操作是不是「部分成功」了（文件被动过）？
 *
 * @returns {null | { path: string, changed: boolean, created: boolean }}
 */
function partialResultOf(snap, call) {
  const item = snap?.[call?.id]
  if (!item) return null
  const after = fileHash(item.path)
  return {
    path: item.path,
    changed: after !== item.before,
    created: item.before === null && after !== null,
  }
}

module.exports = {
  READONLY,
  isReadonly,
  argsHash,
  planBatches,
  snapshotTargets,
  partialResultOf,
  fileHash,
}
