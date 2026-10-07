const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { stamp } = require('./image-save.cjs')

/* ══════════════════════════════════════════════════════════════
   把「对话里那一张图」读成 Buffer

   查看器要「另存为 / 在文件夹里显示 / 复制到剪贴板」，三个都得先把图
   拿到主进程手里。对话里的图片来源有三种（见 src/lib/markdown/inline.ts
   的图片规则，CSP 里 img-src 也放行的就是这三种）：

     · file:///E:/...            本地文件（生图落盘、工作目录里的图）
     · data:image/png;base64,... 内联（用户贴的小图）
     · https://...               网图

   ★ 只读**用户点名的那一张**：整条链路没有「列磁盘」的能力，
     所以它不等于开了一个任意读盘的口子。路径也不做 resolveInside ——
     图片本来就可能在工作目录外面（生图可存到用户自选的 D:\图库）。
   ══════════════════════════════════════════════════════════════ */

/** 单张图上限。模型出的图撑死几 MB，超过 64MB 基本是选错了地方 */
const MAX_BYTES = 64 * 1024 * 1024

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
}

function mimeExt(mime) {
  return EXT_BY_MIME[String(mime ?? '').split(';')[0].trim().toLowerCase()] ?? 'png'
}

function guardSize(size) {
  if (size > MAX_BYTES) {
    throw new Error(`图片太大（${Math.round(size / 1024 / 1024)} MB），上限 64 MB`)
  }
}

/**
 * 读一张图。
 *
 * @param {string} src  `file:` / `data:` / `http(s):` 三种前缀之一
 * @returns {Promise<{buffer: Buffer, name: string}>} name 是给保存框的默认文件名
 */
async function loadImage(src) {
  const text = String(src ?? '').trim()
  if (!text) throw new Error('没有图片地址')

  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(text)
  if (inline) {
    const buffer = Buffer.from(inline[2], 'base64')
    guardSize(buffer.length)
    return { buffer, name: `image-${stamp()}.${mimeExt(inline[1])}` }
  }

  if (/^file:/i.test(text)) {
    const file = fileURLToPath(text)
    const stat = fs.statSync(file)
    guardSize(stat.size)
    return { buffer: fs.readFileSync(file), name: path.basename(file) }
  }

  if (/^https?:\/\//i.test(text)) {
    const response = await fetch(text)
    if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    guardSize(buffer.length)
    const ext = mimeExt(response.headers.get('content-type'))
    return { buffer, name: `image-${stamp()}.${ext}` }
  }

  throw new Error('这个地址读不了（只认本地文件 / 内联 data: / http(s) 图片）')
}

module.exports = { loadImage, MAX_BYTES }
