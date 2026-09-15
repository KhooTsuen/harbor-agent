/**
 * Agent 循环：选模型
 *
 * 从 loop.cjs 拆出来的（那边过 300 行了）。
 *
 * 「这活儿该派给谁」有两层判断：
 *   · **意图路由**（mode-router）—— 用户是要查资料、写东西，还是改代码？
 *     这个不换模型，只是把意图告诉模型和界面。
 *   · **模型路由**（router）—— 按角色/场景挑一个更合适的模型。
 *     默认**关闭**：自动换模型不透明，用户会觉得「回答风格怎么变了」。
 *
 * 判定依据只有两个信号：最后一条用户消息的文本、有没有带图。
 * 两个都从对话里现取 —— 不额外维护状态，就不会有状态不同步的问题。
 */

const router = require('./router.cjs')
const modeRouter = require('./mode-router.cjs')

/** @returns {{ userText: string, provider: object, model: string }} */
function resolveRoute({ config, provider, options, emit }) {
  /*
   * 路由：不同活儿派不同模型。关掉时（默认）就是始终用 assistant.model。
   * 判定依据是「最后一条用户消息」和「有没有带图」。
   */
  const lastUser = [...(options.history ?? [])].reverse().find((m) => m.role === 'user')
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : ''
  const hasImages = Array.isArray(lastUser?.content)
  const modeDecision = modeRouter.resolve(userText, options.forcedMode ?? '')
  emit({
    type: 'mode',
    mode: modeDecision.mode,
    confidence: modeDecision.confidence,
    reason: modeDecision.reason,
  })

  const routed = router.resolve({
    config: { ...config, activeProvider: provider },
    scene: 'chat',
    text: userText,
    hasImages,
  })

  const useProvider = routed.provider ?? provider
  const useModel = routed.model || config.assistant.model

  if (routed.role) {
    emit({
      type: 'route',
      role: routed.role,
      model: useModel,
      provider: useProvider.id,
      reason: routed.reason,
    })
  }

  return { userText, provider: useProvider, model: useModel }
}

module.exports = { resolveRoute }
