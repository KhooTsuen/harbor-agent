/**
 * 会话级模型（**唯一一处落点**）
 *
 * 用户 2026-09-28 报的 bug：「新建对话选择 gpt 模型但还是用的 DeepSeek flash」。
 *
 * 根因：输入框那个模型选择器写的是**会话自己的** `thread.model`（也落了会话 meta，
 * 重开还在），但真正发请求那条链路（`handlers/chat.cjs` → `core/loop.cjs`）**从来没读过它** ——
 * 模型一直是全局 `config.assistant.model`。所以选了什么、界面上写着什么，
 * 实际跑的都是全局那个，而且**一点报错都没有**（「看似可用、实际不是它」）。
 *
 * 为什么是「注入 config」而不是「多传一个 model 参数」：
 *   提示装配、任务预设、压缩、真正那次调用……一路上十几个地方读的都是
 *   `config.assistant.model`。注入一处，就全都跟着换；传参数则要每处都记得传，
 *   漏一处就是「某些环节用了 A 模型、某些环节用了 B 模型」——比不修更难查。
 *
 * 供应商不用在这里挑：`loop-route.providerForRun` 会按**模型**再挑一次
 * （`activeProvider()` 不看模型，正是那个坑）。
 *
 * 空串 / 没带 = 用全局，保持原行为。
 */

/**
 * @param {object} config 全局配置（`config.get()` 的结果）
 * @param {unknown} payloadModel 请求里带的会话级模型
 * @returns {{ config: object, model: string, scoped: boolean }}
 */
function withRequestedModel(config, payloadModel) {
  const requested = typeof payloadModel === 'string' ? payloadModel.trim() : ''
  if (!requested) {
    return { config, model: String(config?.assistant?.model ?? ''), scoped: false }
  }
  return {
    config: { ...config, assistant: { ...config.assistant, model: requested } },
    model: requested,
    scoped: true,
  }
}

module.exports = { withRequestedModel }
