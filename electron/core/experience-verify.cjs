/**
 * 可信验证器（蓝图 §8）—— **只有这一处的结论算「修法已验证」**
 *
 * ── 为什么不能拿「工具返回 ok」当验证 ──
 *
 * 2026-11-02 的自检 `194` 里，网页那段是喂给 `afterRun` 的三条 `ok: true`，
 * 于是「三次成功 → verified」这条链看起来是通的 —— 但**没有任何东西看过结果**。
 * 真实世界里的对应情形是：模型说「这次好了」、工具返回一段看起来正常的正文、
 * 用户根本没参与。把这种自述当证据，等于让模型自己给自己发合格证。
 *
 * 所以这里有两条硬规矩：
 *   ① **不相信 `run.ok`**。验证器拿着参数自己去现场看（`fs.statSync` 目标、
 *      读结构化 `exitCode`），`ok` 只能决定「要不要来核一次」。
 *   ② **没有验证器的情形一律不给结论**（`no_verifier`）—— 那条经验就留在
 *      candidate（不可注入）。这不是漏做，是刻意留白：宁可让一条真经验多等，
 *      也不许一条假经验进提示。
 *
 * ── 现在接入了哪些 ──
 *
 * | 验证器 | 覆盖的工具 | 它自己去核什么 |
 * |---|---|---|
 * | `file_present` | read_file / list_dir / read_image | 目标现在到底在不在、可不可读 |
 * | `file_change_applied` | write_file / edit_file | 写完的文件真的存在且非空 |
 * | `shell_exit_zero` | run_shell | 结构化退出码是不是 0（不看正文一个字） |
 *
 * **没接的**：`browse` / `edge_*`（需要浏览器面板）、`search_web`（外部世界随时会变）、
 * `download`（落地位置可能被策略改）、`memory_*` 等。这些工具成功后**不会**推动
 * 任何经验升级 —— 自检 `195` 钉着这一条（网页场景三次成功仍停在 candidate）。
 * 要接新的，就在这里加一张表项，别在 `experience-loop` 里写 `if (tool === ...)`。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 验证器 id —— 别在别处写字面量 */
const ID = {
  FILE_PRESENT: 'file_present',
  FILE_CHANGE: 'file_change_applied',
  SHELL_ZERO: 'shell_exit_zero',
}

/** 系统错误码（ENOENT / EACCES…）—— 诊断里要说清「是哪种不可访问」 */
function codeOf(error) {
  const code = error && typeof error === 'object' ? error.code : ''
  return code ? String(code) : 'EUNKNOWN'
}

/** 目标路径 → 绝对路径（相对路径按这次调用的工作目录展开） */
function absOf(workdir, target) {
  const raw = String(target ?? '')
  if (!raw) return ''
  if (path.isAbsolute(raw)) return raw
  return path.resolve(String(workdir || process.cwd()), raw)
}

/**
 * 验证器表。每一项：
 *   · `tools`：它认哪些工具（正则，命中就是「这一类结果我敢核」）
 *   · `observe({ args, workdir, facts })` → `{ ok, evidence }`
 *     —— 只说它**自己看到**的事实，不说「应该没问题」。
 *
 * @type {Array<{ id: string, version: number, tools: RegExp,
 *   observe: (input: { args: object|null, workdir: string, facts: object }) => { ok: boolean, evidence: string } }>}
 */
const VERIFIERS = [
  {
    id: ID.FILE_PRESENT,
    version: 1,
    tools: /^(read_file|list_dir|read_image)$/,
    observe({ args, workdir }) {
      const target = absOf(workdir, args?.path ?? args?.dir ?? '')
      if (!target) return { ok: false, evidence: '没有目标路径，无法独立核对' }
      try {
        const stat = fs.statSync(target)
        if (stat.isDirectory()) return { ok: true, evidence: `目录确实存在：${target}` }
        if (stat.size <= 0) return { ok: false, evidence: '目标存在但是空文件（读到的东西没有内容）' }
        return { ok: true, evidence: `文件确实可读（${stat.size} 字节）` }
      } catch (error) {
        return { ok: false, evidence: `目标不可访问：${codeOf(error)}` }
      }
    },
  },
  {
    id: ID.FILE_CHANGE,
    version: 1,
    tools: /^(write_file|edit_file)$/,
    observe({ args, workdir }) {
      const target = absOf(workdir, args?.path ?? '')
      if (!target) return { ok: false, evidence: '没有目标路径，无法独立核对' }
      try {
        const stat = fs.statSync(target)
        if (!stat.isFile() || stat.size <= 0) return { ok: false, evidence: '目标不是非空文件' }
        return { ok: true, evidence: `落盘确认：${target}（${stat.size} 字节）` }
      } catch (error) {
        return { ok: false, evidence: `目标不存在或不可读：${codeOf(error)}` }
      }
    },
  },
  {
    id: ID.SHELL_ZERO,
    version: 1,
    tools: /^(run_shell|run_project_test)$/,
    /*
     * 进程类只认结构化退出码：正文里的「[退出码 0]」是给人看的文本，
     * 而 `exitCode` 是 `run_shell` 从 `error.code` 搬上来的硬事实（见 tool-failure.cjs）。
     * 超时 / 中断没有退出码 —— 一律不算通过。
     */
    observe({ facts }) {
      const data = facts ?? {}
      if (data.timedOut === true) return { ok: false, evidence: '命令超时被杀，没有正常结束' }
      if (data.aborted === true) return { ok: false, evidence: '命令被中断，没有正常结束' }
      if (!Number.isInteger(data.exitCode)) return { ok: false, evidence: '没有拿到退出码，不能确认命令跑完' }
      if (data.exitCode !== 0) return { ok: false, evidence: `退出码 ${data.exitCode}` }
      return { ok: true, evidence: '退出码 0（进程正常结束）' }
    },
  },
]

/** 这次调用归哪个验证器管；没有就是 `null`（= 这类结果现在没人核） */
function verifierFor(toolName) {
  const name = String(toolName ?? '')
  if (!name) return null
  return VERIFIERS.find((entry) => entry.tools.test(name)) ?? null
}

/**
 * 给一次**成功**下结论。
 *
 * @param {{ toolName?: string, args?: object|null, workdir?: string,
 *           ok?: boolean, facts?: object }} input
 * @returns {{ accepted: boolean, reason: string, evidence: string,
 *             verifier: string, validator: { id: string, version: number } | null }}
 *   `reason` 是给日志 / 自检看的：`ok` / `no_verifier` / `not_ok` / `observer_rejected`
 */
function certify(input = {}) {
  const toolName = String(input.toolName ?? '')
  const entry = verifierFor(toolName)
  if (!entry) {
    return { accepted: false, reason: 'no_verifier', evidence: '', verifier: '', validator: null }
  }
  const tag = `${entry.id}@${entry.version}`
  if (input.ok !== true) {
    return { accepted: false, reason: 'not_ok', evidence: '', verifier: tag, validator: null }
  }
  let verdict
  try {
    verdict = entry.observe({ args: input.args ?? null, workdir: String(input.workdir ?? ''), facts: input.facts ?? {} })
  } catch (error) {
    /* 验证器自己挂了 = 这次没能核 → 不给结论（绝不当成通过） */
    verdict = { ok: false, evidence: `验证器执行失败：${codeOf(error)}` }
  }
  if (!verdict?.ok) {
    return { accepted: false, reason: 'observer_rejected', evidence: String(verdict?.evidence ?? ''), verifier: tag, validator: null }
  }
  return { accepted: true, reason: 'ok', evidence: String(verdict.evidence ?? ''), verifier: tag, validator: { id: entry.id, version: entry.version } }
}

module.exports = { ID, VERIFIERS, verifierFor, certify, absOf }
