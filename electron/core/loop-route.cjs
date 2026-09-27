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

const configCore = require('./config.cjs')
const router = require('./router.cjs')
const modeRouter = require('./mode-router.cjs')

/**
 * 这次跑该用哪个供应商：
 *   `activeProvider()` 只看「第一个启用且有 key」，**不看模型** —— 会话级换了模型
 *   （或全局默认模型属于另一个供应商）时，拿它去查 key / 发请求都会错：
 *   要么误报「还没填 Key」，要么把模型名发给不提供它的上游（400）。
 * 所以先按**模型**挑一个，再查 key。
 */
function providerForRun(config) {
  /*
   * `config.activeProvider` 有两种形状：真实配置上是**函数**，而各处的测试夹具/探针
   * 直接塞一个**供应商对象**（旧写法 `config.activeProvider ? config.activeProvider : …`
   * 靠三元把这个差异吞掉了）。这里显式兼容，别让夹具一传对象就炸。
   */
  const raw = config.activeProvider
  const base = typeof raw === 'function' ? raw() : raw || configCore.activeProvider()
  if (!base) throw new Error('没有可用的供应商')
  /* 传 config 进去：会话级模型是注入到这份配置里的，两边必须看同一份 */
  const provider = configCore.providerForModel(config.assistant.model, config) ?? base
  if (!configCore.hasKey(provider)) throw new Error(`${provider.name} 还没填 API Key`)
  return provider
}

/** @returns {{ userText: string, provider: object, model: string }} */function resolveRoute({ config, provider, options, emit }) {
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

  const useModel = routed.model || config.assistant.model
  /*
   * ★ 模型定了之后，供应商要按**这个模型**再确认一次。
   *
   * 上游传进来的 provider 是 `activeProvider()` 挑的 —— 只认「第一个启用且有 key」，
   * **不看模型**。配了多个供应商、而默认模型只属于靠后那个时，每一轮都会先把模型
   * 发给一个根本不提供它的供应商：上游必然 400，然后降级（还会把模型名换成对方
   * 的 `models[0]`，等于**悄悄换模型**）。真机验收实测到了这个。
   *
   * 路由（router）明确指定了供应商就听路由的；否则按模型挑。
   */
  const useProvider = routed.provider ?? configCore.providerForModel(useModel) ?? provider

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

module.exports = { resolveRoute, providerForRun }
