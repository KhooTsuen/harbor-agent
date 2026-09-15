/**
 * 模型路由
 *
 * 一个长期个人 Agent 不该所有活都用一个模型：
 * 起标题、翻译、压缩摘要用贵模型是浪费；而复杂规划和代码修改用便宜模型
 * 会反复返工，反而更贵。
 *
 * 所以按**角色**派模型：
 *
 *   fast       快而便宜，日常问答
 *   reasoning  强推理，规划和分析
 *   coding     代码修改
 *   vision     读图（OCR、看截图）
 *   cheap      标题、翻译、摘要这类「顺手活」
 *
 * 判定顺序（先具体后笼统）：
 *   ① 场景（title/compact/translate/suggest → cheap；ocr → vision）
 *   ② 用户消息里的意图关键词（改代码 / 为什么 / 看图）
 *   ③ 兜底到 assistant.model
 *
 * **用户可以完全关掉它**（config.router.enabled 默认 false）——
 * 自动换模型这事如果做得不透明，用户会一头雾水「怎么回答风格变了」。
 */

const roles = require('./config-defaults.cjs').MODEL_ROLES

/** 场景 → 角色 */
const SCENE_ROLE = {
  chat: null, // 看内容决定
  title: 'cheap',
  prompt: 'cheap',
  translate: 'cheap',
  suggest: 'cheap',
  compact: 'fast',
  ocr: 'vision',
  image: null, // 画图走单独的 images 接口，不在这里路由
}

/** 意图关键词 → 角色。顺序有意义：越具体的放前面 */
const INTENT_RULES = [
  [
    /(改|修|实现|重构|写)[^，。！？;]{0,4}(代码|函数|组件|模块|测试|脚本|接口)|fix|refactor|implement|debug/i,
    'coding',
  ],
  [/(为什么|原因|分析|设计|方案|规划|权衡|架构)/, 'reasoning'],
  [/(看图|这张图|截图|图里|识别.*字|OCR)/i, 'vision'],
  [/(翻译|起个标题|摘要|总结成一句话|起名)/, 'cheap'],
]

/**
 * 判断这轮该用哪个角色。
 *
 * @param {{ scene?: string, text?: string, hasImages?: boolean }} context
 */
function pickRole({ scene = 'chat', text = '', hasImages = false } = {}) {
  if (hasImages) return 'vision'

  const sceneRole = SCENE_ROLE[scene]
  if (sceneRole) return sceneRole

  for (const [pattern, role] of INTENT_RULES) {
    if (pattern.test(String(text))) return role
  }
  return null
}

/**
 * 决定这次用哪个供应商和模型。
 *
 * @param {object} options
 * @param {object} options.config      主进程配置
 * @param {string} [options.role]      已判定的角色（没有就自己判）
 * @param {string} [options.scene]
 * @param {string} [options.text]
 * @param {boolean} [options.hasImages]
 * @returns {{ provider: object|null, model: string, role: string|null, reason: string }}
 */
function resolve({ config, role, scene = 'chat', text = '', hasImages = false }) {
  const active = config.activeProvider ?? require('./config.cjs').activeProvider()
  const fallback = {
    provider: active,
    model: config.assistant.model,
    role: null,
    reason: '默认模型',
  }

  if (!config.router?.enabled) return fallback

  const wanted = role ?? pickRole({ scene, text, hasImages })
  if (!wanted) return fallback

  const configured = config.router.roles?.[wanted]
  if (!configured) {
    return { ...fallback, role: wanted, reason: `没配 ${wanted} 角色，用默认模型` }
  }

  /* 允许写成 "providerId/model" 或直接写模型名（沿用当前供应商） */
  const [maybeProvider, maybeModel] = configured.includes('/')
    ? configured.split('/', 2)
    : ['', configured]

  const target = maybeProvider
    ? (config.providers ?? []).find((p) => p.id === maybeProvider && p.enabled)
    : active

  if (!target) {
    return { ...fallback, role: wanted, reason: `角色 ${wanted} 指的供应商不存在，回退默认` }
  }

  return {
    provider: target,
    model: maybeModel || config.assistant.model,
    role: wanted,
    reason: `角色 ${wanted}`,
  }
}

/** 给界面用：解释「这句话会走哪个模型」——让路由不神秘 */
function explain({ config, text = '', scene = 'chat', hasImages = false }) {
  const role = pickRole({ scene, text, hasImages })
  const picked = resolve({ config, role, scene, text, hasImages })
  return {
    role,
    enabled: config.router?.enabled === true,
    model: picked.model,
    providerId: picked.provider?.id ?? '',
    reason: picked.reason,
  }
}

module.exports = { ROLES: roles, SCENE_ROLE, pickRole, resolve, explain }
