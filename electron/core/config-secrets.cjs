/**
 * 配置 ↔ 凭证库的桥
 *
 * 界面传来的 `apiKey` 有三种含义，必须分清楚（搞错就是「改个超时时间结果
 * 把真 key 写成了一串圆点」这种事故）：
 *
 *   '••••••••'  →  没改，保持库里那把
 *   'sk-xxxx'    →  填了新值，写进凭证库
 *   ''           →  明确清空
 *   字段不存在    →  没改（和掩码同义）
 *
 * 落进 config 的永远只有 credentialRef。
 */

const config = require('./config.cjs')
const credentials = require('./credentials.cjs')

/** 界面用的掩码串。**只在这里定义一次** */
const MASK = '••••••••'

/**
 * 吸收 providers 数组里的密钥。
 *
 * 顺带处理「供应商被删了」—— 它的密钥也要跟着删，
 * 否则凭证库里会攒下一堆再也用不到的 key。
 */
function absorbProviders(incoming) {
  const existing = config.get().providers
  const kept = new Set()

  const out = incoming.map((raw) => {
    const provider = { ...raw }
    const ref = provider.credentialRef || credentials.refForProvider(provider.id)
    kept.add(ref)

    const draft = provider.apiKey
    if (draft === '') {
      credentials.remove(ref)
    } else if (typeof draft === 'string' && draft !== MASK) {
      credentials.set(ref, draft)
    }

    delete provider.apiKey
    return { ...provider, credentialRef: ref }
  })

  for (const old of existing) {
    const ref = old.credentialRef || credentials.refForProvider(old.id)
    if (!kept.has(ref)) credentials.remove(ref)
  }

  return out
}

/** 同理，处理搜索密钥 */
function absorbSearch(patch) {
  if (!patch || typeof patch !== 'object') return patch

  const next = { ...patch }
  const draft = next.apiKey
  if (draft === undefined) return next

  const ref =
    next.credentialRef || `search:${next.provider || config.get().search.provider || 'custom'}`
  if (draft === '') credentials.remove(ref)
  else if (draft !== MASK) credentials.set(ref, draft)

  next.credentialRef = ref
  delete next.apiKey
  return next
}

/** 整个 partial 过一遍 */
function absorb(partial) {
  const incoming = { ...(partial ?? {}) }
  if (Array.isArray(incoming.providers)) incoming.providers = absorbProviders(incoming.providers)
  if (incoming.search) incoming.search = absorbSearch(incoming.search)
  return incoming
}

module.exports = { MASK, absorb, absorbProviders, absorbSearch }
