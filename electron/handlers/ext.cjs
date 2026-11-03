/**
 * 浏览器扩展的入口
 *
 * ── ① IPC（Phase 2）───────────────────────────────────────────
 *
 * 渲染层把**当前打开的会话 id** 报给主进程。为什么必须有它：扩展送来的页面内容
 * 要落进「用户正在看的那条会话」，而「当前打开的是哪条」只有渲染层知道（主进程
 * 没有这个概念）。这是用户拍板的方案 B 的一部分（命中硬禁区 #9「新增 IPC 通道」，
 * 已单独批准）。
 *
 * ⚠️ 上报是**尽力而为**：渲染层没报过（或报的会话已被删）时，桥会**新建一条专用
 *    会话**兜底（见 core/ext-bridge.cjs 的 ingest）—— 页面内容不丢。
 *
 * ── ② 下行指令服务单例（Phase 3a）─────────────────────────────
 *
 * `electron/core/tools/edge-*.cjs` 这一族工具要调 `ext-command.cjs` 的
 * click / type / navigate…，而工具**不在装配链上**（它们是按需 require 的）。
 * 所以这里存一个模块级单例：装配时 `setCommand()` 注入，工具 `getCommand()` 取用。
 *
 * ★ 为什么照这一套（而不是让工具自己建一个 extCommand）：那样会造出**第二个
 *   指令实例**，回执按 id 配对就配不上（回执进的是真桥那条链）。
 *   同一先例：`tools/browse.cjs` 也是这么拿内嵌浏览器的。
 *
 * ── ③ 「安装浏览器插件」（2026-11）────────────────────────────
 *
 * 两条通道：`ext:status` 只读报状态、`ext:install` 真装（幂等）。
 * **都只收动作名，不收任何路径** —— 路径全在 `core/edge-install.cjs` 里算，
 * 否则等于给界面开一个「往任意位置写注册表」的口子（详见那份文件头）。
 *
 * 「装好了」的判据只有一条：**桥上有活连接**（扩展真的连上来了）。文件都在、
 * 注册表也对，但 Edge 里还没加载扩展时，界面上不能写已安装。
 */
let command = null

/** 装配时注入（register-handlers.cjs 创建 extCommand 之后） */
function setCommand(instance) {
  command = instance && typeof instance === 'object' ? instance : null
}

/** 工具取用。**可能为 null**（自检里没装配）—— 调用方必须自己兜底 */
function getCommand() {
  return command
}

function register({ ipcMain, bridge }) {
  const paths = require('../core/paths.cjs')
  const installer = require('../core/edge-install.cjs')

  /** 当前状态。`connected` 从桥上现取 —— 它是唯一能说「装好了」的判据 */
  const snapshot = () =>
    installer.status({
      dataDir: paths.DIRS.data,
      root: paths.DIRS.root,
      connected: (() => {
        try {
          return bridge.connectionCount() > 0
        } catch {
          return false
        }
      })(),
    })

  ipcMain.handle('ext:activeSession', (_event, id) => bridge.setActiveSession(id))

  ipcMain.handle('ext:status', () => snapshot())

  /* 装完顺手把 edge://extensions 打开 —— 下一步就得在那儿点，省一次手动找 */
  ipcMain.handle('ext:install', () => {
    const result = installer.apply({ dataDir: paths.DIRS.data, root: paths.DIRS.root })
    const status = snapshot()
    return result.ok ? { ...result, ...status, opened: installer.openExtensionsPage().ok } : result
  })
}

module.exports = { register, setCommand, getCommand }
