const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const scene = require('../scene.cjs')
const { resolvePath } = require('./_shared.cjs')

/*
 * generate_image —— 让 Agent 自己画图
 *
 * 用哪家、哪个模型，走的是「设置 → 对话 → 场景 → 画图」那一个配置 ——
 * 和输入框工具栏里那个「画图」按钮是同一个。配一次，两边都能用。
 *
 * ── 为什么要落盘，不直接把 URL 给模型 ──
 * 中转站返回的图片链接**大多 24–72 小时就过期**。只把链接记住，明天再看
 * 这条对话图就裂了。所以这里下载下来存进工作目录，永久有效。
 * （实测过：界面能直接加载本地 file:// 图片，不用再搭一套协议。）
 *
 * ── 模型看不到图 ──
 * 返回的是 markdown 图片语法，**给人看的**；模型自己不认图（除非是多模态的）。
 * 所以文字里也说清楚存到哪了，方便下一步操作（比如把图塞进文档）。
 */

/** 图片落在工作目录的哪个子目录下 */
const OUTPUT_DIR = 'generated'

module.exports = {
  name: 'generate_image',
  description:
    '生成图片（文生图）。用「设置 → 场景 → 画图」里配的那个生图模型。prompt 要具体：主体、动作、环境、光线、风格。可选 size 指定比例（如 "16:9"、"1:1"）。图片会保存到工作目录的 generated/ 子目录并显示给用户。生成通常要几十秒，慢的话可能到两三分钟。',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '画面描述，中英文都行。写具体：主体 / 动作 / 环境 / 光线 / 风格',
      },
      size: {
        type: 'string',
        description: '比例或像素，如 "16:9"、"1:1"、"1024x1024"。不填用服务端默认',
      },
      taskId: {
        type: 'string',
        description: '只查这个任务、不重新生成（上一次超时后拿到的那串 task_id）',
      },
    },
    /*
     * 不写 required：prompt 和 taskId 是「二选一」，
     * JSON Schema 的 required 表达不了或的关系。具体在 run 里查，报错也更清楚。
     */
  },

  /** 联网 + 花钱 + 往工作目录写文件 —— 归到需要确认那一类 */
  network: true,

  summarize(args) {
    const taskId = String(args?.taskId ?? '').trim()
    if (taskId && !String(args?.prompt ?? '').trim()) return `查询图片任务 ${taskId}`
    const prompt = String(args?.prompt ?? '').trim()
    const short = prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt
    return `生成图片：${short || '(空描述)'}`
  },

  async run(args, ctx = {}) {
    const prompt = String(args?.prompt ?? '').trim()
    const taskId = String(args?.taskId ?? '').trim()
    const size = String(args?.size ?? '').trim()

    if (!prompt && !taskId) {
      throw new Error('要给我画面描述（prompt）；或者给一个 taskId，让我接着查上一次的任务')
    }

    const result = await scene.generateImage({
      prompt,
      size: size || undefined,
      taskId: taskId || undefined,
    })

    /* 超时不等于失败：任务还在跑，把任务号交出去让它稍后再查 */
    if (!result.ok && result.pending && result.taskId) {
      return [
        `还没画完（等了一会儿就先不等了）。任务号：\`${result.taskId}\``,
        '',
        `过一两分钟可以用 generate_image({ taskId: "${result.taskId}" }) 再查一次，不会重复扣费。`,
      ].join('\n')
    }
    if (!result.ok) throw new Error(result.error)

    const saved = await saveImage(result.image, ctx)
    const alt = prompt.replace(/[[\]]/g, '').slice(0, 60) || '生成的图片'

    return [
      `画好了（${result.model}）。`,
      '',
      `![${alt}](${saved.url})`,
      '',
      `已存到：${saved.file}`,
    ].join('\n')
  },
}

/* ── 存盘 ─────────────────────────────────────────────────── */

/**
 * 把拿到的图片写进工作目录。
 *
 * 两种来源：`data:image/png;base64,xxx`（同步站点）或 http(s) 链接（异步站点出图后）。
 */
async function saveImage(image, ctx) {
  const { buffer, ext } = await readImage(image)
  const relative = path.join(OUTPUT_DIR, `image-${stamp()}.${ext}`)

  /* 走统一的工作目录检查（和 write_file 同一条路，不绕过权限） */
  const file = resolvePath(relative, ctx.workdir, ctx)

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buffer)

  /* 界面要能直接显示本地图 —— file:// 在这儿是能加载的（实测过） */
  return { file, url: pathToFileURL(file).href }
}

async function readImage(image) {
  const text = String(image ?? '')

  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(text)
  if (inline) {
    return { buffer: Buffer.from(inline[2], 'base64'), ext: extOf(inline[1]) }
  }

  if (/^https?:\/\//i.test(text)) {
    const response = await fetch(text)
    if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    return { buffer, ext: extOf(response.headers.get('content-type') ?? '') }
  }

  throw new Error('拿到的图片地址不认识（既不是 data: 也不是 http(s)）')
}

/** 按 MIME 猜扩展名；猜不出就当 png（中转站绝大多数出 png） */
function extOf(mime) {
  const type = String(mime).toLowerCase()
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('webp')) return 'webp'
  return 'png'
}

/** 文件名用本地时间戳 + 毫秒，连画多张也不会撞名 */
function stamp() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`
  )
}
