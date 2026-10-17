/**
 * Codex MCP 桥的**审批委派**（2026-10-17 第三阶段 · 真实审批 UI）
 *
 * ── 它做什么 ──────────────────────────────────────────────────
 *
 * 给桥造一个 `ctx.confirm`：`tools/index.cjs` 的写确认与风险确认都会调它。
 *
 *   ① **受信任命令**（`node -v` / `git --version` / 受限测试那些）→ **策略批准**。
 *      它们是编译进代码的常量命令（外部只能给 id、给不出命令），再让用户为
 *      「读个版本号」或「跑一次固定测试」点头只是骚扰。
 *   ② **其余一切**（尤其写文件）→ **委派给发起这次操作的那条对话的真 confirm**
 *      （`chatConfirm.askUser` → PermissionBar）。用户第 1、9 条：必须是真的那张卡。
 *   ③ **拿不到对话上下文 → 拒绝**（fail-closed）。绝不用「当前活跃会话」顶替 ——
 *      那会把卡发给一个**没请求过这件事**的人（用户第 2 条）。
 *
 * ── 为什么单列一个文件 ────────────────────────────────────────
 *
 * `codex-mcp-bridge.cjs` 已经 297 行贴着 300 红线。审批这块自成一体
 * （判据 + 文案 + 注入），搬出来既能腾行，也能被自检直接喂假 ctx 跑。
 *
 * ⚠️ 不 require electron（自检在纯 Node 里跑）。
 */

const context = require('./codex-mcp-context.cjs')

/** 卡上显示的来源（用户第 3 条：必须展示来源） */
const SOURCE = 'Codex（经 MCP 桥）'

/**
 * 把桥的请求**补上来源标注**再交给渲染层。
 *
 * 渲染层要的四样（用户第 3 条）：**来源 / 目标路径 / 操作类型 / 影响范围**。
 * 后三样本来就有（`kind` → 界面翻成「修改文件」· `args.path` + `diff` · `impact`），
 * 来源是这条通道独有的，必须补上 —— 否则用户看到一张卡，不知道是谁要写文件。
 *
 * @param {object} request `approval.ask` 传下来的请求
 * @param {{ sessionId?: string }} entry 那一轮的上下文
 */
function decorate(request, entry) {
  const impact = Array.isArray(request?.impact) ? request.impact : []
  const who = String(entry?.sessionId ?? '')
  return {
    ...request,
    impact: [
      `来源：${SOURCE}${who ? `（对话 ${who}）` : ''}`,
      '发起者不是 Harbor 自己的模型：这是外部 Codex CLI 通过 MCP 桥请求 Harbor 执行的工具调用',
      ...impact,
    ],
  }
}

/**
 * 造一个 `makeConfirm(runId)`。
 *
 * @param {{ trustedCmdSet?: Set<string>, note?: (m: string) => void,
 *           recheck?: (name: string, request: object) => boolean }} deps
 *        `trustedCmdSet` = 受信任命令集合（诊断 + 受限测试；命令都是 Harbor 的常量）
 *        `recheck` = 用户点了「允许」**之后**再核一次开关（批准期间权限被关掉 → 按拒绝）
 * @returns {(runId: string) => (request: object) => Promise<boolean>}
 */
function createApproval(deps = {}) {
  const trustedCmdSet = deps.trustedCmdSet instanceof Set ? deps.trustedCmdSet : new Set()
  const note = typeof deps.note === 'function' ? deps.note : () => {}

  /**
   * @param {string} runId 这次调用属于哪一轮对话（由 codex 透传回来）
   * @returns {(request: object) => Promise<boolean>}
   */
  return function makeConfirm(runId) {
    return async function confirm(request) {
      const name = String(request?.name ?? '')
      const command = String(request?.args?.command ?? '')

      /* ① 受信任命令（白名单诊断 / 受限测试）—— 策略批准（既有行为，不打扰用户） */
      if (name === 'run_shell' && trustedCmdSet.has(command)) {
        note(`审批：${name} ${JSON.stringify(command)} → 批准（白名单命令）`)
        return true
      }

      /* ② 其余（写文件等）→ 必须真人点头；拿不到上下文就拒 */
      const entry = context.get(runId)
      if (!entry) {
        note(`审批：${name} → 拒绝（拿不到发起这次操作的对话上下文，fail-closed）`)
        return false
      }

      let ok = false
      try {
        ok = (await entry.confirm(decorate(request, entry))) === true
      } catch (error) {
        /* 审批链路自己坏了 → **按拒绝**（同 approval.cjs 的 fail-closed 立场） */
        note(`审批：${name} → 拒绝（审批链路异常：${String(error?.message || error)}）`)
        return false
      }
      if (!ok) {
        note(`审批：${name} → 用户拒绝或超时`)
        return false
      }
      /*
       * ★ 用户第 5 条：**卡挂着的时候权限被关掉了**，不能因为「点得早」就获得旧权限。
       *   所以批准之后**再核一次**当前开关 —— 拿到的权限必须是「此刻仍然开着」的。
       * 判据由调用方注入（`recheck` 返回 true = 仍然允许）；没注入时按「不变」处理。
       */
      if (typeof deps.recheck === 'function' && deps.recheck(name, request) !== true) {
        note(`审批：${name} → 拒绝（批准期间权限已被关闭，按拒绝结算）`)
        return false
      }
      note(`审批：${name} → 用户批准`)
      return true
    }
  }
}

module.exports = { createApproval, decorate, SOURCE }
