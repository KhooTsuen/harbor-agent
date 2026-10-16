/**
 * 浏览器扩展的入口（Phase 2 只有 IPC；本轮起**也持有下行指令服务**）
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
 * ── ② 下行指令服务单例（本轮）─────────────────────────────────
 *
 * `electron/core/tools/edge-*.cjs` 这一族工具要调 `ext-command.cjs` 的
 * click / type / navigate…，而工具**不在装配链上**（它们是按需 require 的）。
 * 所以这里存一个模块级单例：装配时 `setCommand()` 注入，工具 `getCommand()` 取用。
 *
 * ★ 为什么照这一套（而不是让工具自己建一个 extCommand）：那样会造出**第二个
 *   指令实例**，回执按 id 配对就配不上（回执进的是真桥那条链）。
 *   同一先例：`tools/browse.cjs` 也是这么拿内嵌浏览器的。
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
  ipcMain.handle('ext:activeSession', (_event, id) => bridge.setActiveSession(id))
}

module.exports = { register, setCommand, getCommand }
