/**
 * 场景模型解析
 *
 * 「默认模型与提示词」那一页里，每个场景可以单独指定用哪个模型。
 * 这里负责回答一个问题：**某个场景现在该用谁。**
 *
 * 为什么要按场景分：不同活儿对模型的要求差很远 ——
 *   · 起标题、翻译、优化提示词 —— 短、要快、要便宜，用大模型是浪费
 *   · 聊天、压缩 —— 要理解力，用主力模型
 *   · OCR —— 必须支持视觉输入，普通模型根本读不了图
 *   · 画图 —— 是另一个 API（images/generations），跟聊天完全两回事
 *
 * 没配的场景一律回退到默认（assistant.model + 当前供应商），
 * 所以这一页可以不管，功能照样能跑。
 */

const config = require('./config.cjs')
const llm = require('./llm.cjs')
const log = require('./log.cjs')

/** 场景清单。改这里要同步 前端 constants/scenes.ts 和 config.cjs 的默认值 */
const SCENES = ['chat', 'title', 'prompt', 'translate', 'suggest', 'compact', 'ocr', 'image']

/**
 * 解析某个场景该用哪个供应商和模型。
 *
 * @param {string} sceneId
 * @returns {{ provider: object|null, model: string, fallback: boolean }}
 */
function resolve(sceneId) {
  const cfg = config.get()
  const scene = cfg.scenes?.[sceneId]

  /* 配了就用配的 —— 但供应商得真实存在，不然是脏数据 */
  if (scene?.providerId && scene?.model) {
    const provider = cfg.providers.find((p) => p.id === scene.providerId)
    if (provider && config.hasKey(provider)) {
      return { provider, model: scene.model, fallback: false }
    }
    if (provider) {
      log.warn(`场景 ${sceneId} 指的供应商 ${provider.id} 没填 Key，回退到默认`)
    }
  }

  return { provider: config.activeProvider(), model: cfg.assistant.model, fallback: true }
}

/** 给界面看：每个场景现在实际会用谁 */
function snapshot() {
  const cfg = config.get()
  return SCENES.map((id) => {
    const configured = cfg.scenes?.[id] ?? { providerId: '', model: '' }
    const resolved = resolve(id)
    return {
      id,
      providerId: configured.providerId,
      model: configured.model,
      /** 实际生效的（配了就是配的，没配就是默认） */
      effectiveProviderId: resolved.provider?.id ?? '',
      effectiveProviderName: resolved.provider?.name ?? '',
      effectiveModel: resolved.model,
      fallback: resolved.fallback,
    }
  })
}

/** 所有可用模型（按供应商分组），设置页的下拉用 */
function modelOptions() {
  const cfg = config.get()
  return cfg.providers.map((provider) => ({
    providerId: provider.id,
    providerName: provider.name,
    enabled: provider.enabled,
    models: provider.models,
  }))
}

/** 这个场景有没有配成「需要视觉输入」，用于提前给出提示 */
function needsVision(sceneId) {
  return sceneId === 'ocr'
}

/**
 * 把「模型读不了图」的报错翻译成人话。
 *
 * 各家措辞不一样（invalid content type / image not supported / ...），
 * 但共同点是返回里会提到 image 或 multimodal。不翻译的话，用户看到的
 * 是一串英文，不知道其实是「这个模型不支持看图」。
 */
function explainVisionError(message, model) {
  const text = String(message ?? '')
  const looksVisionRelated =
    /image|multimodal|vision|content type|modality/i.test(text) &&
    /(invalid|unsupported|not support|400)/i.test(text)

  if (!looksVisionRelated) return message
  return `${model} 这个模型读不了图片。去「设置 → 模型与提示词」把这一项换成支持图像理解的模型。

服务端原话：${text}`
}

/**
 * 用某个场景的模型跑一次对话。
 *
 * 所有「一次问答」型场景（起标题 / 翻译 / 优化 / 建议 / OCR）都走这里，
 * 免得每个 handler 各写一遍「取供应商、拼参数、处理错误」。
 *
 * @param {string} sceneId
 * @param {{ messages: Array, maxTokens?: number, temperature?: number, signal?: AbortSignal }} options
 */
async function call(sceneId, { messages, maxTokens = 512, temperature = 0.3, signal }) {
  const { provider, model } = resolve(sceneId)

  if (!provider) {
    throw new Error('还没有配置供应商，去「设置 → 模型」加一个')
  }
  if (!config.hasKey(provider)) {
    throw new Error(`${provider.name} 没填 API Key，去「设置 → 模型」补上`)
  }

  const result = await llm.chatStream({
    baseUrl: provider.baseUrl,
    apiKey: config.providerKey(provider),
    chatPath: provider.chatPath,
    model,
    messages,
    temperature,
    maxTokens,
    signal,
  })

  log.info(`场景 ${sceneId} 用了 ${provider.id}/${model}`)
  return { text: (result.content ?? '').trim(), model, provider }
}

/**
 * 场景的「单轮问答」包装：给一段提示 + 用户内容，拿回纯文本。
 *
 * 会顺手把结果里的引号和 markdown 装饰剥掉 —— 起标题、翻译这类场景
 * 要的是干净的文本，模型却常常回一句「好的，标题是：xxx」。
 */
async function ask(sceneId, { system, user, maxTokens = 512, signal }) {
  const result = await call(sceneId, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens,
    signal,
  })
  return result
}

/**
 * OCR：把图片交给视觉模型，拿回文字。
 *
 * 走的是 OpenAI 的多模态格式 —— messages 的 content 从字符串换成数组。
 * 供应商不支持视觉的话，多半会返回 400，这里把错误原样抛出去，
 * 用户能在界面上看到「这个模型读不了图」。
 */
async function ocr({ imageDataUrl, signal }) {
  const { provider, model } = resolve('ocr')
  if (!config.hasKey(provider)) {
    throw new Error('OCR 需要一个支持视觉输入的模型，去「设置 → 模型与提示词」配一下')
  }

  const result = await llm.chatStream({
    baseUrl: provider.baseUrl,
    apiKey: config.providerKey(provider),
    chatPath: provider.chatPath,
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '把这张图片里的文字原样提取出来。只输出文字本身，不要加任何说明、不要用代码块包起来。如果图里没有文字，就输出「（图里没有文字）」。保留原有的换行和大致排版。',
          },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0,
    maxTokens: 2048,
    signal,
  })

  return { text: (result.content ?? '').trim(), model }
}

/**
 * 图像生成：走 /images/generations，异步任务会自动轮询到出图（见 image-task.cjs）
 *
 * `taskId` 传了就只查不提交 —— 接着等上一次超时的那张图。
 */
async function generateImage({ prompt, size, signal, taskId, once }) {
  const { provider, model, fallback } = resolve('image')

  /*
   * 没配「画图」场景时 resolve 会回退到默认聊天模型 —— 而聊天模型调
   * /images/generations 只会 404。与其让模型拿到一个 404 自己猜，
   * 不如直接说清楚该去哪配。
   */
  if (fallback && !taskId) {
    throw new Error(
      '「画图」还没指定模型。去「设置 → 对话 → 场景 → 画图」挑一个生图模型；' +
        '生图和聊天是两套 API，聊天模型画不了图。',
    )
  }
  if (!config.hasKey(provider)) {
    throw new Error(`供应商 ${provider.name || provider.id} 还没填 API Key`)
  }
  if (!model) {
    throw new Error('图像生成没有指定模型')
  }

  return await llm.generateImage({
    baseUrl: provider.baseUrl,
    apiKey: config.providerKey(provider),
    model,
    prompt,
    size,
    signal,
    taskId,
    once,
  })
}

module.exports = {
  SCENES,
  resolve,
  call,
  ask,
  ocr,
  generateImage,
  snapshot,
  modelOptions,
  needsVision,
  explainVisionError,
}
