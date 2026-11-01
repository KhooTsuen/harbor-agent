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
    /*
     * 会话自己选了模型就听会话的 —— 但**供应商要按这个模型再挑一次**：
     * 压缩场景默认是「activeProvider + 便宜模型」那套，会话模型属于另一个供应商时
     * 会把模型名发给不提供它的上游（400）。
     */
    const requestedModel = typeof payload?.model === 'string' ? payload.model.trim() : ''
    const provider = requestedModel
      ? config.providerForModel(requestedModel) ?? picked.provider
      : picked.provider
    if (!provider) return { ok: false, error: '还没有配置供应商' }
    if (!config.hasKey(provider)) return { ok: false, error: `${provider.name} 还没填 API Key` }

    try {
      const model = payload?.model || picked.model
      /*
       * ★ 2026-10-20：必须把「这个模型能吃多少」传下去。
       *   不给的话内核只会把**整段历史**一次发出去 —— 用户实测 150 万 token 的会话
       *   压缩请求本身就超了上游 104 万上限，回 400「maximum context length」。
       *   传了之后内核会按窗口分块摘要（map-reduce），调用次数有硬上限。
       */
      /* 窗口解析只有一处（compact.windowOf）—— 自动压缩那条入口也用同一个 */
      const maxInputTokens = compact.windowOf(provider, model)
      const summary = await compact.summarize({
        baseUrl: provider.baseUrl,
        apiKey: config.providerKey(provider),
        chatPath: provider.chatPath,
        model,
        messages: Array.isArray(payload?.messages) ? payload.messages : [],
        maxInputTokens,
      })
      return { ok: true, summary }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

module.exports = { register }
