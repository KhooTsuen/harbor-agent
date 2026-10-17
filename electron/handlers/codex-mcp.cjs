/**
 * IPC：Codex MCP 桥的**设置与权限状态**（2026-10-17 第四阶段）
 *
 * ── 它只做两件事 ──────────────────────────────────────────────
 *
 *   ① `codexMcp:status` —— 把**主进程算出来的真实生效状态**交给界面
 *      （`codex-mcp-switch.resolveState()`）。界面**不许**自己从配置字段猜，
 *      否则会出现「界面显示已启用、后端其实没启用」（用户第 6 条）。
 *   ② `codexMcp:set` —— 改开关。★ **写目录必须在这里验**（用户第 4 条）：
 *      前端传什么都不可信，判据是 `policy.resolveWriteRoot`（必须落在隔离数据根内，
 *      且 realpath 之后仍然如此 —— 挡住 `..`、符号链接、目录联接）。
 *
 * ── 关闭时会发生什么（用户第 5 条）────────────────────────────
 *
 * 写 / 测试开关是**每次调用现读**的（见 `codex-mcp-switch.cjs`），所以关掉之后
 * **新请求立刻被拒**，不需要重启。已经挂着的那张卡由审批层「批准后再核一次」兜住
 * （`codex-mcp-approval.cjs` 的 `recheck`）—— 批准期间权限被关掉就按拒绝结算。
 *
 * ── 什么改动需要重启（用户第 6 条）────────────────────────────
 *
 * 总开关 `enabled`：桥在**主进程启动时**装配命名管道，中途改不了。
 * `resolveState().needsRestart` 会如实告诉界面，界面据此显示「需重启生效」。
 */

const config = require('../core/config.cjs')
const log = require('../core/log.cjs')
const sw = require('../core/codex-mcp-switch.cjs')
const policy = require('../core/codex-mcp-policy.cjs')

/** 写目录校验的**唯一入口**（主进程侧；前端校验只是体验，不是安全边界） */
function checkRoot(root) {
  const { DIRS } = require('../core/paths.cjs')
  const text = String(root ?? '').trim()
  if (!text) return { ok: true, real: '', message: '' }
  const res = policy.resolveWriteRoot(text, DIRS.data)
  return res.ok === false ? { ok: false, real: '', message: res.message } : { ok: true, real: res.abs, message: '' }
}

/**
 * 真实状态 + 写根校验结果（界面拿它渲染）。
 * @returns {object}
 */
function status() {
  const state = sw.resolveState()
  const checked = checkRoot(state.write.root)
  return {
    ...state,
    /* 根配了但不合法 → 如实标出来（不会静默当成可用） */
    write: { ...state.write, rootValid: checked.ok, rootError: checked.message },
  }
}

function register({ ipcMain }) {
  ipcMain.handle('codexMcp:status', () => ({ ok: true, state: status() }))

  ipcMain.handle('codexMcp:set', (_event, partial) => {
    const patch = partial && typeof partial === 'object' ? partial : {}
    /* ★ 写根必须在主进程验过才落盘 —— 非法值直接拒，不写进配置 */
    if (typeof patch.writeRoot === 'string') {
      const checked = checkRoot(patch.writeRoot)
      if (!checked.ok) {
        log.warn(`Codex MCP：拒绝设置写目录（${checked.message}）`)
        return { ok: false, error: checked.message, state: status() }
      }
    }
    config.patch({ codexMcp: { ...sw.settings(), ...patch } })
    log.info(`Codex MCP 设置已更新：${JSON.stringify(patch)}`)
    return { ok: true, state: status() }
  })
}

module.exports = { register, status, checkRoot }
