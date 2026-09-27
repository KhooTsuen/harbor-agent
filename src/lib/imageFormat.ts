/* ══════════════════════════════════════════════════════════════
   图片「该不该转、缩到多少」的**判定层**（纯函数，不碰 DOM / canvas）

   从 `imageNormalize.ts` 拆出来的 —— 那边要跑 canvas，这边只要字节就能判。
   拆开还有一个好处：这一层在 jsdom 里**能直接测**（不依赖画布）。

   两条规则（用户 2026-09-28 连续两次真机 400 换来的）：

     · **格式**：上游只收 webp / png / jpeg / gif。不在里面的（Windows 剪贴板截图
       常常是 **BMP**，选图那条路还允许 .bmp）一律转掉。
     · **尺寸**：长边 > `MAX_EDGE` 等比缩小。上游对「尺寸离谱」和「格式不对」
       给的是**同一句** unsupported image —— 一亿像素的旧图（14200×7104）就是这么
       让「发新消息」失败、却看着像「格式没修好」的。

   合规的**原样透传**（不重新编码：重编码掉画质，还可能变大）。
   ══════════════════════════════════════════════════════════════ */

/** 上游收的格式（报错原文里列的那四个） */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 长边上限。够看清截图里的字，又不至于让一次请求几十万 token */
export const MAX_EDGE = 2048

/** 解码前先按**原始体积**拦一道：BMP 是未压缩的，屏幕截图能到几十 MB */
export const MAX_INPUT_BYTES = 30 * 1024 * 1024

/** 只读前 64KB 就够多数格式报出尺寸 */
export const PROBE_BYTES = 64 * 1024

/** 不支持时转成什么：照片继续用 JPEG（体积小），其余用 PNG（无损，截图里的字清楚） */
const FALLBACK_FOR = (sourceType: string): string =>
  /jpe?g/i.test(sourceType) ? 'image/jpeg' : 'image/png'

export interface Size {
  width: number
  height: number
}

export interface ImageShape extends Size {
  type: string
  bytes: number
}

export interface ImagePlan extends Size {
  mode: 'passthrough' | 'convert'
  /** 目标 mime（passthrough 时与输入一致） */
  type: string
  /** 人话原因，用于提示/日志（例：「bmp → png」/「4096×2304 → 2048×1152」） */
  reason: string
}

export interface NormalizedImage {
  dataUrl: string
  /** 有没有动过（没动就是原样透传） */
  changed: boolean
  reason: string
}

/** 缩放后的尺寸（等比，长边不超过 maxEdge；本来就小就原样） */
export function fitInside(width: number, height: number, maxEdge = MAX_EDGE): Size {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * 从**字节头**里读出宽高。
 *
 * 为什么要这么抠：一亿像素的 JPEG 光解码就要占几百 MB，而多数情况我们只想确认
 * 「要不要缩」—— 读个头就知道了（用户那张 14200×7104 就是这么认出来的）。
 * 解不出来的格式（webp 的某些分支 / avif / heic）返回 null，调用方再真解码。
 */
export function probeSize(bytes: Uint8Array): Size | null {
  const le16 = (at: number): number => bytes[at] | (bytes[at + 1] << 8)
  const le32 = (at: number): number =>
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
  const be32 = (at: number): number =>
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
  const ascii = (at: number, len: number): string =>
    String.fromCharCode(...Array.from(bytes.subarray(at, at + len)))

  /* PNG：签名 + IHDR 紧跟在后面 */
  if (bytes.length > 24 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') {
    return { width: be32(16), height: be32(20) }
  }
  /* GIF：逻辑屏幕宽高，小端 */
  if (bytes.length > 10 && ascii(0, 3) === 'GIF') {
    return { width: le16(6), height: le16(8) }
  }
  /* BMP：BITMAPINFOHEADER 里 int32（高度可能为负 = 自顶向下） */
  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { width: Math.abs(le32(18)), height: Math.abs(le32(22)) }
  }
  /* JPEG：扫段找 SOF（和「结尾是不是 FFD9」无关，只看帧头） */
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1
        continue
      }
      const marker = bytes[at + 1]
      const len = (bytes[at + 2] << 8) | bytes[at + 3]
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: (bytes[at + 5] << 8) | bytes[at + 6],
          width: (bytes[at + 7] << 8) | bytes[at + 8],
        }
      }
      if (len <= 0) break
      at += 2 + len
    }
    return null
  }
  /* WebP：RIFF 容器，三种子格式 */
  if (bytes.length > 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const format = ascii(12, 4)
    if (format === 'VP8X') {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      }
    }
    if (format === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff }
    if (format === 'VP8L') {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
    }
    return null
  }
  return null
}

/** 按**魔数**认格式（比解析尺寸便宜，也不依赖能不能解出尺寸） */
function sniffMime(bytes: Uint8Array): string {
  if (bytes.length < 4) return ''
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return ''
}

/** 归一 mime：声明了就用声明的；没声明或声明得不明不白 → 按魔数认 */
export function mimeOf(type: string, bytes?: Uint8Array): string {
  const declared = String(type || '')
    .toLowerCase()
    .split(';')[0]
    .trim()
  const usable = declared && declared !== 'application/octet-stream' && declared !== 'image/*'
  if (usable) return declared
  return (bytes && sniffMime(bytes)) || declared
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

/** 剪贴板里这个文件像不像图（有的来源不给 type，只能看扩展名） */
export function looksLikeImage(file: { type?: string; name?: string }): boolean {
  if (String(file.type ?? '').startsWith('image/')) return true
  return /\.(png|jpe?g|webp|gif|bmp|avif|ico|tiff?|heic)$/i.test(String(file.name ?? ''))
}

/* ── data URL ↔ 字节 / Blob（纯转换，也是两个入口共用的地方） ── */

/** data URL → 字节 + 声明的 mime（读文件头要用字节） */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; type: string } | null {
  const [head, body = ''] = String(dataUrl).split(',')
  const declared = /data:([^;]*)/.exec(head)?.[1] ?? ''
  try {
    if (!/;base64/i.test(head)) {
      return { bytes: new TextEncoder().encode(decodeURIComponent(body)), type: declared }
    }
    const binary = atob(body)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return { bytes, type: declared }
  } catch {
    return null
  }
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
