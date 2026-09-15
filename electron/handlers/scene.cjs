/**
 * 场景 IPC
 *
 * 「默认模型与提示词」里的每个场景，在这里落成一个 handler。
 * 都是「一次问答」型：给一段输入，拿回一段结果。
 *
 * 错误一律原样带回渲染层 —— 用户需要知道是「模型不支持看图」
 * 还是「没配 Key」，而不是一句笼统的失败。
 */

const scene = require('../core/scene.cjs')
const log = require('../core/log.cjs')

/** 把最近几条对话拼成一段可读的文本，给「起标题 / 建议」用 */
function digest(messages, limit = 6) {
  return (messages ?? [])
    .slice(-limit)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content ?? '').slice(0, 800)}`)
    .join('\n')
}

function register({ ipcMain }) {
  /** 各场景现在实际会用哪个模型（设置页展示用） */
  ipcMain.handle('scene:snapshot', () => ({
    scenes: scene.snapshot(),
    providers: scene.modelOptions(),
  }))

  /* ── 标题生成 ─────────────────────────────────────────── */

  ipcMain.handle('scene:title', async (_event, payload) => {
    const text = digest(payload?.messages, 4)
    if (!text.trim()) return { ok: false, error: '没有内容可以起标题' }

    try {
      const { text: raw } = await scene.ask('title', {
        system:
          '你负责给对话起标题。只输出标题本身：不超过 12 个字，不要引号、不要句号、不要「标题：」这种前缀。',
        user: text,
        maxTokens: 64,
      })
      /* 模型常常不听话，带上引号或「标题：」，这里剥掉 */
      const title = raw
        .replace(/^["'「『]|["'」』]$/g, '')
        .replace(/^(标题|title)\s*[:：]\s*/i, '')
        .split('\n')[0]
        .trim()
        .slice(0, 24)

      return title ? { ok: true, title } : { ok: false, error: '模型没给出标题' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /* ── 提示词优化 ───────────────────────────────────────── */

  ipcMain.handle('scene:optimize', async (_event, payload) => {
    const input = String(payload?.text ?? '').trim()
    if (!input) return { ok: false, error: '输入是空的' }

    try {
      const { text } = await scene.ask('prompt', {
        system: [
          '你把用户随口说的一句话，改写成一条清晰、具体、可执行的指令。',
          '规矩：保留原意，不要添加用户没说的需求；补上必要的上下文和验收标准；',
          '直接输出改写后的指令，不要解释你改了什么，不要用代码块包起来。',
        ].join('\n'),
        user: input,
        maxTokens: 800,
      })
      return text ? { ok: true, text } : { ok: false, error: '模型没有返回内容' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /* ── 翻译 ─────────────────────────────────────────────── */

  ipcMain.handle('scene:translate', async (_event, payload) => {
    const input = String(payload?.text ?? '').trim()
    if (!input) return { ok: false, error: '内容是空的' }

    /* 已经是中文就翻成英文，否则翻成中文 —— 不额外问用户 */
    const hasChinese = /[\u4e00-\u9fa5]/.test(input)
    const target = hasChinese ? '英文' : '中文'

    try {
      const { text } = await scene.ask('translate', {
        system: [
          `你把内容翻译成${target}。`,
          '规矩：只输出译文；保留原有的换行、列表和代码块；',
          '代码里的标识符不要翻译；专有名词拿不准就保留原文并加括号注明。',
        ].join('\n'),
        user: input,
        maxTokens: 4096,
      })
      return text ? { ok: true, text, target } : { ok: false, error: '模型没有返回内容' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /* ── 建议回复 ─────────────────────────────────────────── */

  ipcMain.handle('scene:suggest', async (_event, payload) => {
    const text = digest(payload?.messages, 4)
    if (!text.trim()) return { ok: false, error: '没有内容' }

    try {
      const { text: raw } = await scene.ask('suggest', {
        system: [
          '你根据刚才的对话，给出 3 条用户接下来最可能想说的话。',
          '每条不超过 20 个字，是用户视角的提问或指令，不是你的回答。',
          '一行一条，行首加「- 」，不要编号，不要任何其他文字。',
        ].join('\n'),
        user: text,
        maxTokens: 256,
      })

      const suggestions = raw
        .split('\n')
        .map((line) => line.replace(/^\s*[-*\d.、)]+\s*/, '').trim())
        .filter((line) => line.length > 0 && line.length <= 40)
        .slice(0, 4)

      return suggestions.length > 0
        ? { ok: true, suggestions }
        : { ok: false, error: '模型没给出建议' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /* ── OCR ──────────────────────────────────────────────── */

  ipcMain.handle('scene:ocr', async (_event, payload) => {
    const dataUrl = String(payload?.imageDataUrl ?? '')
    if (!dataUrl.startsWith('data:image/')) {
      return { ok: false, error: '需要一张图片' }
    }

    try {
      const result = await scene.ocr({ imageDataUrl: dataUrl })
      log.info(`OCR 完成，${result.text.length} 字（${result.model}）`)
      return { ok: true, text: result.text }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: scene.explainVisionError(message, scene.resolve('ocr').model) }
    }
  })

  /* ── 图像生成 ─────────────────────────────────────────── */

  ipcMain.handle('scene:image', async (_event, payload) => {
    const prompt = String(payload?.prompt ?? '').trim()
    if (!prompt) return { ok: false, error: '描述是空的' }

    try {
      const result = await scene.generateImage({
        prompt,
        size: typeof payload?.size === 'string' ? payload.size : '1024x1024',
      })
      if (result.ok) log.info(`图像生成成功（${result.model}）`)
      return result
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

module.exports = { register }
