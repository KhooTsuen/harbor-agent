/* ══════════════════════════════════════════════════════════════
   图片进模型之前的**格式与尺寸归整**

   为什么要有它（2026-09-28 真机报错）：用户贴了一张图，上游直接 400 ——

     messages[11].image[0]: You have uploaded an unsupported image.
     Please make sure your image is valid and has one of the following
     formats: webp, png, jpeg, and gif.

   根因很朴素：**Windows 剪贴板里的截图经常是 BMP**（`image/bmp`），而「选图片」
   那条路也允许 `.bmp`（`fs:pickImageAsDataUrl` 的 filters 里就写着 bmp）。
   我们两条路都原样发出去，上游当然不认。（这和「模型说看不见图」是两回事 ——
   那次是内核把 base64 按字符切坏了，见 docs/踩坑记录.md。）

   这一层只做两件事，别的都不碰：

     · **格式**：不在白名单里的（bmp / tiff / avif / heic / ico / svg…）转成 PNG
     · **尺寸**：长边超过 `MAX_EDGE` 就等比缩小（原图直发一次就是几十万 token，
       而且很容易撞上「单图请求体过大」）

   白名单里、尺寸也合规的**原样透传** —— 不重新编码（重编码掉画质，还可能变大）。

   ★ 转换用的是**浏览器自己的解码能力**（`createImageBitmap` + canvas 编码）：
     这个仓库不轻易引原生依赖，而 Chromium 本来就能解 BMP / ICO / AVIF，
     比引一个图像库覆盖面还宽。TIFF / HEIC 它解不了 → **在这里就明确报错**，
     而不是发出去被上游拒（用户至少知道该怎么办）。
   ══════════════════════════════════════════════════════════════ */

/** 上游收的格式（报错原文里列的那四个） */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 长边上限。够看清截图里的字，又不至于让一次请求几十万 token */
export const MAX_EDGE = 2048

/** 解码前先按**原始体积**拦一道：BMP 是未压缩的，屏幕截图能到几十 MB */
export const MAX_INPUT_BYTES = 30 * 1024 * 1024

/** 不支持时转成什么：照片继续用 JPEG（体积小），其余用 PNG（无损，截图里的字清楚） */
const FALLBACK_FOR = (sourceType: string): string =>
  /jpe?g/i.test(sourceType) ? 'image/jpeg' : 'image/png'

export interface ImageShape {
  type: string
  width: number
  height: number
  bytes: number
}

export interface ImagePlan {
  mode: 'passthrough' | 'convert'
  /** 目标 mime（passthrough 时与输入一致） */
  type: string
  width: number
  height: number
  /** 人话原因，用于提示/日志（例：「bmp → png」/「4096×2304 → 2048×1152」） */
  reason: string
}

/** 缩放后的尺寸（等比，长边不超过 maxEdge；本来就小就原样） */
export function fitInside(
  width: number,
  height: number,
  maxEdge = MAX_EDGE,
): {
  width: number
  height: number
} {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * 该原样发还是该转（**纯函数**，单测盯的就是它）。
 * 传进来的 type 可能带参数（`image/png;charset=…`）或大小写不一，这里统一归一。
 */
export function planFor(input: ImageShape): ImagePlan {
  const sourceType = String(input.type || '')
    .toLowerCase()
    .split(';')[0]
    .trim()
  const supported = SUPPORTED_IMAGE_TYPES.includes(sourceType)
  const target = fitInside(input.width, input.height)
  const shrunk = target.width !== input.width || target.height !== input.height
  if (!supported) {
    const type = FALLBACK_FOR(sourceType)
    const ext = sourceType.replace('image/', '') || '未知'
    return {
      mode: 'convert',
      type,
      ...target,
      reason: `${ext} → ${type.replace('image/', '')}${shrunk ? `，并缩到 ${target.width}×${target.height}` : ''}`,
    }
  }
  if (shrunk) {
    return {
      mode: 'convert',
      type: sourceType,
      ...target,
      reason: `${input.width}×${input.height} → ${target.width}×${target.height}`,
    }
  }
  return { mode: 'passthrough', type: sourceType, ...target, reason: '原样' }
}

/* ── 解码 / 编码能力（真机走 canvas；单测注入假的，jsdom 里没有 canvas） ── */

export interface DecodedImage {
  width: number
  height: number
  source: CanvasImageSource
  /** 解出来以后要还回去的资源（ImageBitmap#close） */
  release?: () => void
}

export interface ImageCodecs {
  decode: (blob: Blob) => Promise<DecodedImage>
  encode: (
    image: DecodedImage,
    width: number,
    height: number,
    type: string,
    quality?: number,
  ) => Promise<Blob>
  toDataUrl: (blob: Blob) => Promise<string>
}

export const browserCodecs: ImageCodecs = {
  async decode(blob) {
    /* 失败的话抛的是浏览器的话（如「The source image could not be decoded」），
       上层会用下面的 readableError 翻成人话 */
    const bitmap = await createImageBitmap(blob)
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      release: () => bitmap.close(),
    }
  },
  async encode(image, width, height, type, quality) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('画布不可用，转不了格式')
    context.drawImage(image.source, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('图片编码失败'))),
        type,
        quality,
      )
    })
  },
  toDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('读图片内容失败'))
      reader.readAsDataURL(blob)
    })
  },
}

export interface NormalizedImage {
  dataUrl: string
  /** 有没有动过（没动就是原样透传） */
  changed: boolean
  reason: string
}

/** data URL → Blob（「选图片」那条路给回来的是 data URL） */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body = ''] = String(dataUrl).split(',')
  const type = /data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream'
  if (!/;base64/i.test(head)) return new Blob([decodeURIComponent(body)], { type })
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

/**
 * 归整一张图：该透传就透传，该转就转。
 * 体积超限、或浏览器都解不开的格式 → 抛**人话**错误，调用点直接提示用户。
 */
export async function normalizeImage(
  blob: Blob,
  codecs: ImageCodecs = browserCodecs,
): Promise<NormalizedImage> {
  if (blob.size > MAX_INPUT_BYTES) {
    throw new Error(`图片太大（${(blob.size / 1024 / 1024).toFixed(1)}MB），换一张或先压一下再发`)
  }
  if (blob.size === 0) throw new Error('这张图是空的')

  let decoded: DecodedImage
  try {
    decoded = await codecs.decode(blob)
  } catch {
    const ext = String(blob.type || '').replace('image/', '') || '未知格式'
    throw new Error(
      `${ext.toUpperCase()} 这个格式解不开（常见于 TIFF / HEIC），先转成 PNG 或 JPG 再发`,
    )
  }

  try {
    const plan = planFor({
      type: blob.type,
      width: decoded.width,
      height: decoded.height,
      bytes: blob.size,
    })
    if (plan.mode === 'passthrough') {
      return { dataUrl: await codecs.toDataUrl(blob), changed: false, reason: plan.reason }
    }
    const encoded = await codecs.encode(
      decoded,
      plan.width,
      plan.height,
      plan.type,
      plan.type === 'image/jpeg' ? 0.92 : undefined,
    )
    return { dataUrl: await codecs.toDataUrl(encoded), changed: true, reason: plan.reason }
  } finally {
    decoded.release?.()
  }
}

/** 「选图片」那条路：给回来的是 data URL */
export async function normalizeDataUrl(
  dataUrl: string,
  codecs: ImageCodecs = browserCodecs,
): Promise<NormalizedImage> {
  return normalizeImage(dataUrlToBlob(dataUrl), codecs)
}

/** 剪贴板里这个文件像不像图（有的来源不给 type，只能看扩展名） */
export function looksLikeImage(file: { type?: string; name?: string }): boolean {
  if (String(file.type ?? '').startsWith('image/')) return true
  return /\.(png|jpe?g|webp|gif|bmp|avif|ico|tiff?|heic)$/i.test(String(file.name ?? ''))
}
