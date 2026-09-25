/**
 * 上下文分层诊断（token 优化 · 阶段 1）
 *
 * 把系统提示的每一层按「稳定 / 低频 / 动态」三档归位，算 content hash：
 *   · stablePrefixHash    —— 稳定层整体（同一任务内应逐字节不变）
 *   · lowFrequencyHash    —— 低频层（记忆 / 任务计划 / 会话状态）
 *   · dynamicContextHash  —— 动态层（检索片段 / 当前时间）
 *
 * 还负责回答「稳定前缀这轮变没变、变在哪一层」：
 * 和**上一次快照**逐层比 hash，变了就把层名列出来（stablePrefixChangeReason）。
 * 快照按会话存（data/cache/prompt-diag/<sessionId>.json，只留最后一次）。
 *
 * ⚠️ 这些字段只进台账 / 脱敏诊断，**绝不进发给模型的稳定前缀**。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')

/* 与 prompt-stack.ORDER 对齐 —— 不 require 它（避免循环依赖），改 ORDER 时同步这里 */
const STABLE = [
  'coreIdentity',
  'environment',
  'conversationPolicy',
  'userPreferences',
  'projectInstructions',
  'skills',
  'tools',
  'toolPolicy',
  'browserGuide',
  'workRules',
  'safety',
]
const LOW = ['relevantMemory', 'taskState', 'conversationState']
const DYNAMIC = ['retrievedContext', 'currentTime']

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
/** 与 compact.cjs 同一口径的粗估（中文 ~1.5 字/token，取 chars/3 偏保守） */
const estTokens = (text) => Math.ceil(String(text ?? '').length / 3)

function tierOf(id) {
  if (STABLE.includes(id)) return 'stable'
  if (LOW.includes(id)) return 'low'
  return 'dynamic'
}

/** 一层的最终渲染文本（和 prompt-stack.toSystemMessage 的拼法一致） */
function renderLayer(layer) {
  const body = String(layer?.content ?? '').replace(/^## /gm, '### ')
  return `## ${layer?.title ?? ''}\n${body}`
}

function hashTiers(layers) {
  const layerHashes = {}
  const contextTokensByLayer = {}
  const acc = { stable: [], low: [], dynamic: [] }
  for (const layer of layers ?? []) {
    if (!layer?.content) continue
    const text = renderLayer(layer)
    layerHashes[layer.id] = sha(text)
    contextTokensByLayer[layer.id] = estTokens(text)
    acc[tierOf(layer.id)].push(text)
  }
  return {
    stablePrefixHash: sha(acc.stable.join('\n\n')),
    lowFrequencyHash: sha(acc.low.join('\n\n')),
    dynamicContextHash: sha(acc.dynamic.join('\n\n')),
    layerHashes,
    contextTokensByLayer,
  }
}

const snapFile = (sessionId) =>
  path.join(DIRS.chatCache, 'prompt-diag', `${String(sessionId || 'x').replace(/[^\w.-]/g, '_')}.json`)

function readPrev(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(snapFile(sessionId), 'utf8'))
  } catch {
    return null
  }
}

function writePrev(sessionId, snap) {
  try {
    fs.mkdirSync(path.dirname(snapFile(sessionId)), { recursive: true })
    fs.writeFileSync(snapFile(sessionId), JSON.stringify(snap), 'utf8')
  } catch {
    /* 诊断写不进去不阻塞对话 */
  }
}

/**
 * 算这一轮的分层诊断。
 *
 * @param {Array} layers      prompt-stack 的层数组
 * @param {{ sessionId?: string, promptVersion?: string }} options
 */
function diagnose(layers, { sessionId = '', promptVersion = '' } = {}) {
  const hashes = hashTiers(layers)
  const prev = sessionId ? readPrev(sessionId) : null

  let stablePrefixChanged = false
  const reasons = []
  if (prev?.stablePrefixHash && prev.stablePrefixHash !== hashes.stablePrefixHash) {
    stablePrefixChanged = true
    for (const id of STABLE) {
      if (prev.layerHashes?.[id] !== hashes.layerHashes[id]) reasons.push(id)
    }
    if (reasons.length === 0) reasons.push('unknown') /* hash 变了却定位不到层：如实记，别掩盖 */
  }

  if (sessionId) {
    writePrev(sessionId, { at: Date.now(), ...hashes })
  }

  return {
    at: Date.now(),
    promptVersion,
    stablePrefixHash: hashes.stablePrefixHash,
    lowFrequencyHash: hashes.lowFrequencyHash,
    dynamicContextHash: hashes.dynamicContextHash,
    stablePrefixChanged,
    stablePrefixChangeReason: reasons.join(','),
    contextTokensByLayer: hashes.contextTokensByLayer,
    layerHashes: hashes.layerHashes,
  }
}

module.exports = { STABLE, LOW, DYNAMIC, tierOf, hashTiers, diagnose, estTokens }
