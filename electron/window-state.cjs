/**
 * 主窗口的引用
 *
 * 一个只有 get/set 的小模块。存在的理由：主窗口被好几个地方用到
 * （IPC 处理器弹对话框、托盘菜单、流式事件转发），但创建它的只有 main.cjs。
 * 与其让每个模块都自己 `require('electron')` 再猜「哪个窗口是主窗口」，
 * 不如有一个明确的存放点。
 *
 * main.cjs 在 createWindow 里 set()，窗口关闭时 set(null)。
 */

let current = null

function get() {
  return current
}

function set(win) {
  current = win
}

module.exports = { get, set }
