/**
 * 「附加文件」：弹多选框 → 逐个解析 → 交给渲染层（2026-10-08）
 *
 * 替代老的 `fs:pickAndRead`（那条只读文本、撞二进制就拒）。分流表在
 * `core/file-extract.cjs` 的文件头。老的通道**先留着** —— 别的地方可能还在调，
 * 拆两根线的活不在这件事里。
 *
 * 为什么在**主进程**解析而不是渲染层：解析库要读磁盘、要 require 包，
 * 渲染层（沙箱）两样都没有。顺带也把「用户显式选的文件不限工作目录」这条
 * 理由接续上（和 `fs:pickImageAsDataUrl` 一致）。
 */
const { dialog, BrowserWindow } = require('electron')
const { extract } = require('../core/file-extract.cjs')

/** 一次最多附加几个：再多对话框也难选，而且普通一轮根本用不上 */
const MAX_FILES = 5

function register({ ipcMain }) {
  ipcMain.handle('file:attach', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: '选择要附加的文件',
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }

    const picked = result.filePaths.slice(0, MAX_FILES)
    /*
     * **串行**解析，不并发：同时抽几个大 PDF 会在主进程里堆一串同步读盘 +
     * 解析，界面反而更卡。附件本来就是「选完等一下」的场景，慢一点没关系。
     */
    const files = []
    for (const filePath of picked) {
      files.push(await extract(filePath))
    }
    return { ok: true, files, dropped: result.filePaths.length - picked.length }
  })
}

module.exports = { register, MAX_FILES }
