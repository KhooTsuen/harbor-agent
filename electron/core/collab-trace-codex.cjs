/**
 * **Codex 做 B 时的真实痕迹抽取**（2026-10-17）
 *
 * codex-cli 不产 tool_call 给 Harbor（`codex-cli.cjs` 文件头 ①），所以
 * `loop.run` 那种 `toolRuns` 在它这里没有。但它通过 MCP 桥调工具，桥把每次
 * 调用记进 `<data>/codex-mcp-calls.jsonl`（`codex-mcp-lifecycle.cjs` 的 appendCall）。
 *
 * 本模块从那份 jsonl 里**按 runId** 抽出这次执行真实发生过的工具调用，
 * 转成 `collab-trace.cjs` 的 `extractTrace` 能吃的 `toolRuns` 形状。
 *
 * ★ 数据源是桥的**调用记录**（真实发生），不是 codex 的自述 —— 与 openai 走
 *   `toolRuns` 同一口径：只认真实痕迹。
 *
 * ⚠️ 不 require electron。
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * 从 codex-mcp-calls.jsonl 抽某个 runId 的工具调用，转成 toolRuns 形状。
 *
 * @param {string} runId 这次协作执行的 runId
 * @returns {Array<{ name: string, args: object, ok: boolean, output: string }>}
 */
function fromCalls(runId) {
  if (!runId) return []
  let callsFile = ''
  try {
    callsFile = path.join(require('./paths.cjs').DIRS.data, 'codex-mcp-calls.jsonl')
  } catch {
    return []
  }
  let raw = ''
  try {
    raw = fs.readFileSync(callsFile, 'utf8')
  } catch {
    return []
  }
  const runs = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let rec
    try {
      rec = JSON.parse(t)
    } catch {
      continue
    }
    if (rec.runId !== runId) continue
    /* 桥的调用记录里：tool 是 'harbor_xxx'，转成 Harbor 工具名；ok/toolOk 是桥的语义 */
    const name = String(rec.tool ?? '').replace(/^harbor_/, '')
    const output = rec.error
      ? `错误：${String(rec.error?.message ?? rec.error)}`
      : ''
    runs.push({
      name,
      args: rec.args && typeof rec.args === 'object' ? rec.args : {},
      /* 桥的 ok:true 只是「转发成功」，toolOk 才是工具成败；toolOk 为 null 时按 ok 算 */
      ok: rec.toolOk === null || rec.toolOk === undefined ? rec.ok === true : rec.toolOk === true,
      output,
    })
  }
  return runs
}

module.exports = { fromCalls }
