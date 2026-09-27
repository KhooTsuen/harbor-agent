import {
  MAX_INPUT_BYTES,
  dataUrlToBytes,
  fitInside,
  mimeOf,
  planFor,
  probeSize,
  type NormalizedImage,
} from './imageFormat'

/* ══════════════════════════════════════════════════════════════
   真去把图**转掉**（canvas 那一层）

   判定（该不该转、缩到多少）在 `imageFormat.ts`；这里只负责执行：

     · 转换用的是**浏览器自己的解码能力**（`createImageBitmap` + canvas 编码）：
       这个仓库不轻易引原生依赖，而 Chromium 本来就能解 BMP / ICO / AVIF，
       比引一个图像库覆盖面还宽。TIFF / HEIC 解不了 → **在这里就明确报错**，
       而不是发出去被上游拒（用户至少知道该怎么办）。
     · 顺序很重要（用户 2026-09-28 真机：14200×7104 的旧图）：
         ① 先**读文件头** —— 合规就直接透传（不解码，零风险）
         ② 要缩就把目标尺寸**交给解码器**（一亿像素整张读进内存会爆）
         ③ 让解码器缩过之后**必须重新编码** —— 像素已经不是原图了
     · 编解码器可注入：jsdom 里没有 canvas，单测用假的替换（真机那条路由
       `tmp/perf/probe-image-format.cjs` / `probe-huge-history.cjs` 走一遍）。
   ══════════════════════════════════════════════════════════════ */

export type { ImagePlan, NormalizedImage } from './imageFormat'

export interface DecodedImage {
  width: number
  height: number
  source: CanvasImageSource
  /** 解出来以后要还回去的资源（ImageBitmap#close） */
  release?: () => void
}

export interface ImageCodecs {
  /** 解码；给了 `resize` 就在解码时直接缩（**别先整张解出来再缩** —— 一亿像素会吃几百 MB） */
  decode: (blob: Blob, resize?: { width: number; height: number }) => Promise<DecodedImage>
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
  async decode(blob, resize) {
    /* 失败时抛的是浏览器自己的话（如「The source image could not be decoded」），
       上层会翻成人话 */
    const bitmap = resize
      ? await createImageBitmap(blob, {
          resizeWidth: Math.max(1, Math.round(resize.width)),
          resizeHeight: Math.max(1, Math.round(resize.height)),
          resizeQuality: 'high',
        })
      : await createImageBitmap(blob)
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

/** 交给 Blob 时把 Uint8Array 的泛型收窄回 ArrayBuffer（TS 5.7 起 Uint8Array 带泛型参数） */
const toBlob = (bytes: Uint8Array, type: string): Blob =>
  new Blob(
    [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
    { type },
  )

/** 不合规的图给一句**人话**（而不是把浏览器的报错原样甩给用户） */
function readableError(type: string, cause: unknown): Error {
  const ext = (type || '未知格式').replace('image/', '')
  return new Error(
    `${ext.toUpperCase()} 这个格式解不开（常见于 TIFF / HEIC），先转成 PNG 或 JPG 再发`,
    {
      cause,
    },
  )
}

/**
 * 归整一张图（字节进，data URL 出）。
 * 体积超限 / 浏览器也解不开 → 抛**人话**错误，调用点直接提示用户。
 */
export async function normalizeImageBytes(
  bytes: Uint8Array,
  declaredType: string,
  codecs: ImageCodecs = browserCodecs,
): Promise<NormalizedImage> {
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new Error(
      `图片太大（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB），换一张或先压一下再发`,
    )
  }
  if (bytes.byteLength === 0) throw new Error('这张图是空的')

  const type = mimeOf(declaredType, bytes)
  const probed = probeSize(bytes)
  /* 看得懂头又不超尺寸 —— 最省的一条路：不碰解码器 */
  if (probed) {
    const quick = planFor({
      type,
      width: probed.width,
      height: probed.height,
      bytes: bytes.byteLength,
    })
    if (quick.mode === 'passthrough') {
      const blob = toBlob(bytes, type)
      return { dataUrl: await codecs.toDataUrl(blob), changed: false, reason: quick.reason }
    }
  }

  const blob = toBlob(bytes, type)
  const resizeHint = probed ? fitInside(probed.width, probed.height) : null
  const resized =
    Boolean(resizeHint && probed) &&
    (resizeHint!.width !== probed!.width || resizeHint!.height !== probed!.height)

  let decodeError: unknown = null
  let decoded: DecodedImage | null = null
  if (resized) {
    try {
      decoded = await codecs.decode(blob, resizeHint!)
    } catch (error) {
      decodeError = error
    }
  }
  if (!decoded) {
    try {
      decoded = await codecs.decode(blob)
    } catch (error) {
      decodeError = error
    }
  }
  if (!decoded) throw readableError(type, decodeError)

  try {
    const plan = planFor({
      type,
      width: decoded.width,
      height: decoded.height,
      bytes: bytes.byteLength,
    })
    /* 解出来发现本来就合规（比如头里有大 EXIF、没读到尺寸）→ 透传，不重编码 */
    if (plan.mode === 'passthrough' && !resized) {
      return { dataUrl: await codecs.toDataUrl(blob), changed: false, reason: plan.reason }
    }
    /* 缩过的走这里：像素已经变了，必须编码（尺寸用解码器实际给的那个） */
    const encoded = await codecs.encode(
      decoded,
      plan.mode === 'passthrough' ? decoded.width : plan.width,
      plan.mode === 'passthrough' ? decoded.height : plan.height,
      plan.type,
      plan.type === 'image/jpeg' ? 0.92 : undefined,
    )
    return { dataUrl: await codecs.toDataUrl(encoded), changed: true, reason: plan.reason }
  } finally {
    decoded.release?.()
  }
}

/** 归整一个 Blob（剪贴板给的 File 就是 Blob） */
export async function normalizeImage(
  blob: Blob,
  codecs: ImageCodecs = browserCodecs,
): Promise<NormalizedImage> {
  const whole = new Uint8Array(await blob.arrayBuffer())
  return normalizeImageBytes(whole, blob.type, codecs)
}

/*
 * 归整过的图放这儿，同一张只洗一次。几 MB 的字符串算哈希比转换还贵，
 * 所以按「mime + 长度 + 头尾」做指纹。
 */
const CACHE_CHARS = 24 * 1024 * 1024
const convertedCache = new Map<string, string>()
let cachedChars = 0

const fingerprint = (dataUrl: string): string =>
  `${dataUrl.slice(0, 40)}|${dataUrl.length}|${dataUrl.slice(-24)}`

/** 只给测试用：清掉缓存 */
export function clearImageCache(): void {
  convertedCache.clear()
  cachedChars = 0
}

/**
 * 归整一段 data URL（两个入口都走它）。
 *
 * 贴图那条路传进来的是**刚贴的图**；发送前的「最后一米」传的是**要发出去的历史里的图** ——
 * 后者才是用户 2026-09-28 那次 400 的根因：旧会话里那张 14200×7104 会跟着每条新消息
 * 一起发出去，而以前只在「贴进来那一刻」洗。
 */
export async function normalizeDataUrl(
  dataUrl: string,
  codecs: ImageCodecs = browserCodecs,
): Promise<NormalizedImage> {
  const cached = convertedCache.get(fingerprint(dataUrl))
  if (cached) return { dataUrl: cached, changed: true, reason: '这条已经洗过了' }
  const parsed = dataUrlToBytes(dataUrl)
  if (!parsed) throw new Error('这张图读不出来（data URL 坏了），重新贴一张')
  const result = await normalizeImageBytes(parsed.bytes, parsed.type, codecs)
  if (result.changed && cachedChars + result.dataUrl.length <= CACHE_CHARS) {
    convertedCache.set(fingerprint(dataUrl), result.dataUrl)
    cachedChars += result.dataUrl.length
  }
  return result
}
