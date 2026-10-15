/**
 * 浏览器扩展桥的 IPC（Phase 2）
 *
 * 只有一条通道：渲染层把**当前打开的会话 id** 报给主进程。
 *
 * 为什么必须有它：扩展送来的页面内容要落进「用户正在看的那条会话」，而
 * 「当前打开的是哪条」只有渲染层知道（主进程没有这个概念）。这是用户拍板的
 * 方案 B 的一部分（命中硬禁区 #9「新增 IPC 通道」，已单独批准）。
 *
 * ⚠️ 上报是**尽力而为**：渲染层没报过（或报的会话已被删）时，桥会**新建一条
 *    专用会话**兜底（见 core/ext-bridge.cjs 的 ingest）—— 页面内容不丢。
 */

function register({ ipcMain, bridge }) {
  ipcMain.handle('ext:activeSession', (_event, id) => bridge.setActiveSession(id))
}

module.exports = { register }
