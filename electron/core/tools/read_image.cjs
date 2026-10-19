const fs = require('node:fs')
const path = require('node:path')
const { resolvePath } = require('./_shared.cjs')
const capabilities = require('../provider-capabilities.cjs')
const configCore = require('../config.cjs')

const MAX_BYTES = 4 * 1024 * 1024

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes
      .subarray(0, 6)
      .toString('ascii')
      .match(/^GIF8[79]a$/)
  )
    return 'image/gif'
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp'
  return ''
}

function visionTarget(ctx) {
  const config = ctx.vision?.config
  const primary = ctx.vision?.provider
  const model = ctx.vision?.model
  if (
    primary?.baseUrl &&
    configCore.hasKey(primary) &&
    capabilities.resolve(model, primary.modelCapabilities, primary).caps.vision === true
  ) {
    return { provider: primary, model, source: '当前模型' }
  }
  const chosen = config?.scenes?.ocr
  const provider = config?.providers?.find(
    (item) => item.id === chosen?.providerId && item.enabled !== false,
  )
  if (
    provider?.baseUrl &&
    chosen?.model &&
    configCore.hasKey(provider) &&
    capabilities.resolve(chosen.model, provider.modelCapabilities, provider).caps.vision === true
  ) {
    return { provider, model: chosen.model, source: '已配置的识图模型' }
  }
  return null
}

async function describe(bytes, mime, question, name, ctx, target) {
  if (ctx.allowNetwork === false) throw new Error('本次对话禁止联网，无法将图片交给视觉模型')
  if (ctx.signal?.aborted) throw new DOMException('aborted', 'AbortError')
  ctx.emit?.({
    type: 'notice',
    level: 'info',
    title: '正在读取图片',
    text: `${name} 将交给${target.source}识别`,
  })
  const response = await require('../llm.cjs').chatStream({
    baseUrl: target.provider.baseUrl,
    apiKey: configCore.providerKey(target.provider),
    chatPath: target.provider.chatPath,
    model: target.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: String(question || '请描述这张图片中的可见内容。').slice(0, 1000) },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
        ],
      },
    ],
    signal: ctx.signal,
    maxTokens: 1500,
  })
  const answer = String(response?.content ?? '').trim()
  if (!answer) throw new Error('识图模型没有返回描述')
  return `${target.source} ${target.model} 对 ${name} 的识别结果：\n${answer}`
}

async function fromDataUrl(dataUrl, question, ctx = {}) {
  const { bytes, mime } = parseDataUrl(dataUrl)
  const target = visionTarget(ctx)
  if (!target) throw new Error('当前模型无法读图，且尚未配置支持视觉的识图模型')
  return describe(bytes, mime, question, '用户附加图片', ctx, target)
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl ?? '').match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/=]+)$/i)
  if (!match) throw new Error('附件不是受支持的图片 Data URL')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('图片附件必须有效且不超过 4 MB')
  const mime = imageMime(bytes)
  if (!mime || mime !== match[1].toLowerCase()) throw new Error('图片附件格式标记与真实内容不一致')
  return { bytes, mime }
}

module.exports = {
  name: 'read_image',
  description:
    '读取授权目录内的真实图片内容并描述。看到图片路径、截图或用户要求看图时主动使用。需要当前模型支持视觉，或已配置识图模型。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '图片的路径（相对当前对话目录或绝对路径）' },
      question: { type: 'string', description: '想从图片中确认什么' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const file = resolvePath(args.path, ctx.workdir, ctx)
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size < 8 || stat.size > MAX_BYTES)
      throw new Error('图片必须是有效文件，且不超过 4 MB')
    const target = visionTarget(ctx)
    if (!target) throw new Error('当前模型无法读图，且尚未配置支持视觉的识图模型')
    const bytes = fs.readFileSync(file)
    const mime = imageMime(bytes)
    if (!mime) throw new Error('仅支持 PNG、JPEG、GIF、WebP 图片')
    return describe(bytes, mime, args.question, path.basename(file), ctx, target)
  },
  summarize(args) {
    return `读取图片 ${args.path}`
  },
  imageMime,
  visionTarget,
  fromDataUrl,
  parseDataUrl,
}
