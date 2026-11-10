/**
 * 凭证库：明文 → 系统加密的**升级通道**（第 17 项）
 *
 * 为什么单开一个 handler 文件：`handlers/safety.cjs` 顶在 298 行（红线 300），
 * 而这条通道要连 ipcMain 注册、通道清单、preload 三处，塞进去必然破线。
 *
 * ★ 这是**保数据**的动作，不是清空重来：`upgrade()` 先留档、再逐条重加密，
 *   留不下档就中止，原文件一个字节都不动。所以它不要求 `confirm` ——
 *   但界面仍然要先让用户看见「盘上是明文」再点，别做成静默后台操作。
 */
const { ipcMain } = require('electron')

function register({ credentials }) {
  ipcMain.handle('credentials:upgrade', () => {
    try {
      return { ok: true, ...credentials.upgrade() }
    } catch (error) {
      /* 失败原样交出去：调用方要能显示「为什么升不了」，不能吞成 ok:false 一句话 */
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

module.exports = { register }
