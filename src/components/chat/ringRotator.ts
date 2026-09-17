import encoded from '@/assets/banner/aperture-ring.b64?raw'

/* ══════════════════════════════════════════════════════════════
   光圈实时旋转

   资源里存的是**一张高精度密度图**，不是预先渲染好的字符帧。每一帧按当前
   角度重新采样，再把采样值量化成字符。

   为什么不预先渲染成字符帧：要 60 FPS 就得有几百帧（每帧 122×62 字符），
   包体直接涨到兆级；而且那样改一次转速就要重出一整套资源。

   为什么不用 CSS `rotate()` 转整块文本：那会把字符本身也转歪 —— 转 90°
   时整片字母是横躺的。字符必须始终竖直，转的只能是**图形**，所以只能在
   采样阶段把旋转做掉。
   ══════════════════════════════════════════════════════════════ */

/** 由暗到亮的密度字符，索引即灰阶（10 级） */
export const RING_PALETTE = ' .:-=+*#%@'

/** 输出网格：和原始字样的字号对齐后刚好是 122 列 × 62 行 */
export const RING_COLUMNS = 122
export const RING_ROWS = 62

const SCALE = 3
const SOURCE_COLUMNS = RING_COLUMNS * SCALE
const SOURCE_ROWS = RING_ROWS * SCALE

/*
 * 字符网格不是正方形的：等宽字符宽约为高的 0.508 倍。
 * 旋转必须在「正方形像素」空间里算，否则圆环会转成椭圆。
 * 这个系数和原先生成器里用的比例一致，所以观感与之前相同。
 */
const CELL_ASPECT = 0.5082

function decodeSource(): Uint8Array {
  const binary = atob(encoded.trim())
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  if (bytes.length !== SOURCE_COLUMNS * SOURCE_ROWS) {
    throw new Error(
      `光圈资源尺寸不对：期望 ${SOURCE_COLUMNS * SOURCE_ROWS} 字节，实际 ${bytes.length}`,
    )
  }
  return bytes
}

const SOURCE = decodeSource()

/** 双线性采样：坐标是「正方形像素」空间里的源图坐标 */
function sample(sourceX: number, sourceY: number): number {
  if (sourceX < 0 || sourceY < 0 || sourceX > SOURCE_COLUMNS - 1 || sourceY > SOURCE_ROWS - 1) {
    return 0
  }
  const left = Math.floor(sourceX)
  const top = Math.floor(sourceY)
  const right = Math.min(left + 1, SOURCE_COLUMNS - 1)
  const bottom = Math.min(top + 1, SOURCE_ROWS - 1)
  const fx = sourceX - left
  const fy = sourceY - top

  const topRow =
    SOURCE[top * SOURCE_COLUMNS + left] * (1 - fx) + SOURCE[top * SOURCE_COLUMNS + right] * fx
  const bottomRow =
    SOURCE[bottom * SOURCE_COLUMNS + left] * (1 - fx) + SOURCE[bottom * SOURCE_COLUMNS + right] * fx
  return topRow * (1 - fy) + bottomRow * fy
}

function toCharacter(value: number): string {
  const level = Math.round((Math.min(255, Math.max(0, value)) / 255) * (RING_PALETTE.length - 1))
  return RING_PALETTE[level]
}

/** 把光圈转到 `degrees` 并渲染成 ASCII。同一角度结果恒定。 */
export function renderRing(degrees: number): string {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  /* 以格子中心为基准：第 n 格中心在 n + 0.5，网格中心在边长的一半处 */
  const centerX = RING_COLUMNS / 2
  const centerY = RING_ROWS / 2

  const rows: string[] = []
  for (let row = 0; row < RING_ROWS; row += 1) {
    const offsetY = row + 0.5 - centerY
    const line: string[] = []
    for (let column = 0; column < RING_COLUMNS; column += 1) {
      const offsetX = (column + 0.5 - centerX) * CELL_ASPECT
      /* 反向旋转：从输出格子找它在源图上的位置 */
      const sourceX = (offsetX * cos + offsetY * sin) / CELL_ASPECT + centerX
      const sourceY = -offsetX * sin + offsetY * cos + centerY
      line.push(toCharacter(sample(sourceX * SCALE, sourceY * SCALE)))
    }
    rows.push(line.join(''))
  }
  return rows.join('\n')
}
