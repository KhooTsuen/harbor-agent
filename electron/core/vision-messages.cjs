const images = require('./collab-images.cjs')
const kinds = require('./provider-kinds.cjs')

async function prepareMessages(messages, { config, provider, model, signal, allowNetwork, emit }) {
  const out = []
  for (const message of messages ?? []) {
    const parts = Array.isArray(message?.content) ? message.content : null
    const urls = parts?.filter((part) => part?.type === 'image_url').map((part) => part.image_url?.url) ?? []
    if (!urls.length) {
      out.push(message)
      continue
    }
    const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
    const prepared = await images.prepare(urls, {
      kind: kinds.isCodexCli(provider) ? 'codex-cli' : 'openai',
      model,
      providerId: provider.id,
    }, config, { allowNetwork, signal, emit })
    out.push({
      ...message,
      content: images.contentWithImages([text, prepared.analysis].filter(Boolean).join('\n\n'), prepared.images),
    })
  }
  return out
}

module.exports = { prepareMessages }
