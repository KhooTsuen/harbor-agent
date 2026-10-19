const capabilities = require('./provider-capabilities.cjs')
const readImage = require('./tools/read_image.cjs')

function selectedProvider(config, role) {
  return role.providerId
    ? (config.providers ?? []).find((item) => item.id === role.providerId)
    : role.kind === 'openai'
      ? require('./config.cjs').providerForModel(role.model, config)
      : null
}

async function prepare(images, role, config, context = {}) {
  const urls = Array.isArray(images) ? images.filter((image) => typeof image === 'string') : []
  if (urls.length === 0) return { images: [], analysis: '' }
  if (urls.length > 5) throw new Error('图片数量超出单次识图上限（5 张）')
  for (const url of urls) readImage.parseDataUrl(url)
  const provider = selectedProvider(config, role)
  const direct =
    role.kind === 'openai' &&
    provider &&
    capabilities.resolve(role.model, provider.modelCapabilities, provider).caps.vision === true
  if (direct) return { images: urls, analysis: '' }

  const vision = {
    config,
    provider: context.visionProvider ?? provider ?? { kind: 'codex-cli' },
    model: context.visionModel ?? (role.kind === 'codex-cli' ? 'codex-cli' : role.model),
  }
  const notes = []
  for (const dataUrl of urls) {
    notes.push(
      await readImage.fromDataUrl(
        dataUrl,
        context.question || '请描述图片中的可见内容，并优先回答与任务目标有关的信息。',
        {
          vision,
          allowNetwork: context.allowNetwork,
          signal: context.signal,
          emit: context.emit,
        },
      ),
    )
    if (context.signal?.aborted) throw new DOMException('aborted', 'AbortError')
  }
  return { images: [], analysis: notes.join('\n\n') }
}

function contentWithImages(text, images) {
  return [
    { type: 'text', text },
    ...(images ?? []).map((url) => ({ type: 'image_url', image_url: { url } })),
  ]
}

async function prepareRoles(images, roles, config, context = {}) {
  const caps = require('./provider-capabilities.cjs')
  const { providerForRole } = require('./collab-task.cjs')
  const run = async (role, other) => {
    const candidate = other.kind === 'openai' ? providerForRole(config, other) : null
    const helper = candidate && caps.resolve(other.model, candidate.modelCapabilities, candidate).caps.vision === true
      ? { visionProvider: candidate, visionModel: other.model }
      : {}
    const result = await prepare(images, role, config, { ...context, ...helper })
    if (images.length && !result.images.length && !result.analysis)
      throw new Error(`${role.label || '模型'}沒有收到圖片內容`)
    return result
  }
  const planner = await run(roles.planner, roles.executor)
  const executor = await run(roles.executor, roles.planner)
  return { planner, executor }
}

module.exports = { prepare, prepareRoles, contentWithImages }
