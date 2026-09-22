/**
 * 上下文压缩（`chat:compact`）
 *
 * 从 handlers/chat.cjs 拆出来的 —— 那边加完日志就贴 300 行了。
 * 它和对话循环没有关系：自己挑一个（可以更便宜的）模型，把长内容揉成摘要。
 */

const config = require('../core/config.cjs')
const compact = require('../core/compact.cjs')

function register({ ipcMain }) {
  ipcMain.handle('chat:compact', async (_event, payload) => {
    /* 压缩可以单独配一个便宜的模型 —— 它只是把长内容揉成摘要 */
    const scene = require('../core/scene.cjs')
    const picked = scene.resolve('compact')
    const provider = picked.provider
    if (!provider) return { ok: false, error: '还没有配置供应商' }
    if (!config.hasKey(provider)) return { ok: false, error: `${provider.name} 还没填 API Key` }

    try {
      const summary = await compact.summarize({
        baseUrl: provider.baseUrl,
        apiKey: config.providerKey(provider),
        chatPath: provider.chatPath,
        model: payload?.model || picked.model,
        messages: Array.isArray(payload?.messages) ? payload.messages : [],
      })
      return { ok: true, summary }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

module.exports = { register }
