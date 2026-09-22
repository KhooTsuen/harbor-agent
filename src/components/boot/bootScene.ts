/* ══════════════════════════════════════════════════════════════
   启动页 ASCII 场景：解码 + 绘制

   数据由 `scripts/generate-boot-scene.py` 生成，产物是
   `src/assets/boot-scene/scene.b64`（zlib 压缩后再 base64 的文本）。

   为什么存成 base64 文本而不是 .bin：Electron 里页面是 file:// 加载的，
   对 file:// 做 fetch 会被拦；`?raw` 导入又能把二进制读坏。base64 文本
   两条路都走得通。

   为什么走 canvas 而不是 DOM：4K 网格是 46,080 个格子。项目实测
   2 万个 DOM 节点切换要 1 秒、12 万个要 9 秒 —— 这条路一开始就不通。
   真机测过：46,080 个字形画进一张 3840×2160 的 canvas 约 0.24–0.42 秒。
   ══════════════════════════════════════════════════════════════ */

/** 字格用的字体。生成脚本用的是 Consolas 粗体（Windows 自带） */
export const BOOT_SCENE_FONT = 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace'

const MAGIC = 'HBS1'
const VERSION = 3
/* 与生成脚本的 HEAD_FMT 一一对应，改一边必须改另一边 */
const HEAD_BYTES = 4 + 1 + 2 + 2 + 1 + 1 + 1 + 1 + 1 + 2 + 2 + 3

/*
 * 层号与 `scripts/boot_scene_layers.py` 的常量一一对应（改一边要改另一边）：
 *   1 天空 2 海面 3 岛 4 灯塔 5 渔船 6 倒影 7 窗
 * 只把海面动画用到的列在这里；其余留给以后做 Idle / 渔船 / 星星时再补。
 */
export const SCENE_LAYER = {
  sky: 1,
  ocean: 2,
  island: 3,
  lighthouse: 4,
  boat: 5,
  reflection: 6,
  window: 7,
} as const

export interface BootScene {
  cols: number
  rows: number
  cellW: number
  cellH: number
  fontPx: number
  charset: string
  /** 每个字形的墨量（0-255，空格是 0） */
  coverage: Uint8Array
  /** 每格的层号（见 SCENE_LAYER） */
  layer: Uint8Array
  /** n*3 的 RGB */
  palette: Uint8Array
  /** 每格一个字符索引 */
  glyph: Uint8Array
  /** 每格一个调色板索引 */
  color: Uint8Array
  lampCol: number
  lampRow: number
  /** 统一底色，画在字符底下 */
  bg: string
}

/** 解开一个已经解压过的字节流（测试里直接喂这个，不用碰压缩） */
export function parseBootScene(raw: Uint8Array): BootScene {
  if (raw.byteLength < HEAD_BYTES) throw new Error('启动场景数据太短')
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3])
  if (magic !== MAGIC) throw new Error(`启动场景数据头不对：${magic}`)

  let at = 4
  const version = view.getUint8(at)
  at += 1
  if (version !== VERSION) throw new Error(`启动场景版本不认识：${version}`)
  const cols = view.getUint16(at, true)
  at += 2
  const rows = view.getUint16(at, true)
  at += 2
  const cellW = view.getUint8(at)
  at += 1
  const cellH = view.getUint8(at)
  at += 1
  const fontPx = view.getUint8(at)
  at += 1
  const paletteN = view.getUint8(at)
  at += 1
  const charsetN = view.getUint8(at)
  at += 1
  const lampCol = view.getUint16(at, true)
  at += 2
  const lampRow = view.getUint16(at, true)
  at += 2
  const bgR = view.getUint8(at)
  const bgG = view.getUint8(at + 1)
  const bgB = view.getUint8(at + 2)
  at += 3

  const charset = new TextDecoder('ascii').decode(raw.subarray(at, at + charsetN))
  at += charsetN
  const coverage = raw.slice(at, at + charsetN)
  at += charsetN
  const layer = raw.slice(at, at + cols * rows)
  at += cols * rows
  const palette = raw.slice(at, at + paletteN * 3)
  at += paletteN * 3
  const cells = raw.subarray(at, at + cols * rows * 2)
  if (cells.byteLength < cols * rows * 2) throw new Error('启动场景格子数据不完整')

  const glyph = new Uint8Array(cols * rows)
  const color = new Uint8Array(cols * rows)
  for (let i = 0; i < cols * rows; i += 1) {
    glyph[i] = cells[i * 2]
    color[i] = cells[i * 2 + 1]
  }
  if (charset.length !== charsetN) throw new Error('启动场景字符集读坏了')
  if (coverage.byteLength !== charsetN) throw new Error('启动场景字形墨量表读坏了')
  if (layer.byteLength !== cols * rows) throw new Error('启动场景层掩码读坏了')

  return {
    cols,
    rows,
    cellW,
    cellH,
    fontPx,
    charset,
    coverage,
    layer,
    palette,
    glyph,
    color,
    lampCol,
    lampRow,
    bg: `rgb(${bgR}, ${bgG}, ${bgB})`,
  }
}

/** base64 → zlib 解压 → 解析 */
export async function loadBootScene(base64: string): Promise<BootScene> {
  const binary = atob(base64.trim())
  const packed = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) packed[i] = binary.charCodeAt(i)

  /*
   * 只用 DecompressionStream + reader，不碰 Blob/Response：
   * jsdom 里的 Blob 没有 stream()，走那条路单测直接跑不起来。
   * 写入和读取同时进行（不等 write 完再读），否则大一点的数据会互相等死。
   */
  const ds = new DecompressionStream('deflate')
  const writer = ds.writable.getWriter()
  const pump = writer.write(packed).then(() => writer.close())
  const reader = ds.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.length
  }
  await pump

  const raw = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    raw.set(part, at)
    at += part.length
  }
  return parseBootScene(raw)
}

/**
 * 按屏幕宽度决定隔几个格子取一个。
 * 场景是 4K 生成的，1080p 屏上隔点取正好回到 192×60 —— 少画 3/4 的字符。
 */
export function sceneStride(naturalWidth: number, deviceWidth: number): number {
  return deviceWidth >= naturalWidth * 0.75 ? 1 : 2
}

/** 取步长之后的网格尺寸（绘制与动画都按这个尺寸算） */
export function sceneGrid(scene: BootScene, stride: number): { cols: number; rows: number } {
  return { cols: Math.ceil(scene.cols / stride), rows: Math.ceil(scene.rows / stride) }
}

/** 把某个调色板索引转成 css 颜色 */
export function paletteColor(scene: BootScene, index: number): string {
  return `rgb(${scene.palette[index * 3]}, ${scene.palette[index * 3 + 1]}, ${
    scene.palette[index * 3 + 2]
  })`
}

/** 把场景画进 canvas（按颜色分批，减少 fillStyle 切换） */
export function paintBootScene(canvas: HTMLCanvasElement, scene: BootScene, stride: number): void {
  const cols = Math.ceil(scene.cols / stride)
  const rows = Math.ceil(scene.rows / stride)
  canvas.width = cols * scene.cellW
  canvas.height = rows * scene.cellH
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.fillStyle = scene.bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.font = `bold ${scene.fontPx}px ${BOOT_SCENE_FONT}`
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'

  const buckets = new Map<number, number[]>()
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const cell = y * stride * scene.cols + x * stride
      const key = scene.color[cell]
      let list = buckets.get(key)
      if (!list) {
        list = []
        buckets.set(key, list)
      }
      list.push(cell, x, y)
    }
  }

  buckets.forEach((list, key) => {
    ctx.fillStyle = paletteColor(scene, key)
    for (let i = 0; i < list.length; i += 3) {
      const cell = list[i]
      const ch = scene.charset[scene.glyph[cell]]
      if (ch === ' ') continue
      ctx.fillText(ch, list[i + 1] * scene.cellW, list[i + 2] * scene.cellH)
    }
  })
}
