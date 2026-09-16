const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { resolvePath } = require('./tools/_shared.cjs')
const config = require('./config.cjs')

/* ══════════════════════════════════════════════════════════════
   生图结果落盘

   从 generate-image.cjs 抽出来的 —— 因为现在有**两个**地方要存图：

     · 工具自己（同步拿到图时）
     · 后台守望者（异步出图后，由 main 触发）

   路径和命名两边必须一致，抽出来才不会各写一份。
   ══════════════════════════════════════════════════════════════ */

/** 图片落在工作目录的哪个子目录下 */
const OUTPUT_DIR = 'generated'

/**
 * 把拿到的图片写进工作目录。
 *
 * 两种来源：`data:image/png;base64,xxx`（同步站点）或 http(s) 链接
 * （异步站点出图后给的是链接，且**大多 24–72 小时过期**，必须落盘）。
 *
 * @param {string} image
 * @param {object} ctx  至少要 { workdir }；有 sessionId 更好（走统一的权限检查）
 * @returns {Promise<{file:string, url:string}>} url 是可直接给 <img src> 用的 file://
 */
async function saveImage(image, ctx = {}) {
  const { buffer, ext } = await readImage(image)
  const name = `image-${stamp()}.${ext}`

  /*
   * 用户自定义了保存目录（设置 → 对话 → 生图保存位置）就存那里。
   * 用户自己选的目录视为已授权，不走工作目录的权限检查 ——
   * 不然「存到 D:\图库」这种再正常不过的需求会被 Workspace Only 拦住。
   */
  const customDir = String(config.get().image?.dir ?? '').trim()
  if (customDir) {
    const file = path.join(customDir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, buffer)
    return { file, url: pathToFileURL(file).href }
  }

  /* 默认：工作目录下的 generated/（走统一的权限检查，和 write_file 同一条路） */
  const file = resolvePath(path.join(OUTPUT_DIR, name), ctx.workdir, ctx)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buffer)
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

module.exports = { OUTPUT_DIR, saveImage, readImage, extOf, stamp }
