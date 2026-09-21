/**
 * 把面板贴到输入区**上方**的定位计算（纯函数，方便测）。
 *
 * 为什么要抽出来：jsdom 里所有元素的 `getBoundingClientRect()` 都是 0，
 * 所以「贴对了没有」在单元测试里量不出来 —— 只能把这段数学单独测干净，
 * 再去真机上量 rect（见 `tools/probe-*.js` 里那种验证脚本）。
 *
 * 坐标系：视口左上角为原点，y 向下增长。
 */

/** 面板底边与输入区顶边之间的空隙 */
export const ANCHOR_GAP = 8
/** 面板底边至少离视口底部这么多（别被状态栏压住） */
export const ANCHOR_MIN_BOTTOM = 8
/** 面板顶边至少离视口顶部这么多（窗口很矮时别把它顶出去） */
export const ANCHOR_MIN_TOP = 8

/**
 * 面板应当距离视口底部多少像素。
 *
 * @param composerTop    输入区顶边距视口顶部的距离（`rect.top`）
 * @param viewportHeight 视口高度（`window.innerHeight`）
 * @param panelHeight    面板自己的高度 —— 窗口太矮时靠它把面板压回视口内
 */
export function anchoredBottom(
  composerTop: number,
  viewportHeight: number,
  panelHeight = 0,
  gap: number = ANCHOR_GAP,
): number {
  const top = Number(composerTop)
  const height = Number(viewportHeight)
  const panel = Number(panelHeight)
  if (!Number.isFinite(top) || !Number.isFinite(height)) return ANCHOR_MIN_BOTTOM

  /* 正常情况：面板底边落在输入区顶边上方 gap 处 */
  const wanted = Math.round(height - top + gap)

  /*
   * 但窗口很矮、输入区又贴着顶部时，上面根本没那么多地方 ——
   * 那就把面板往下压到「顶边至少留 ANCHOR_MIN_TOP」。没有这一条，
   * 面板会被放到视口外（bottom 大于视口高度），看起来像没弹出来。
   */
  const safePanel = Number.isFinite(panel) ? Math.max(0, panel) : 0
  const ceiling = Math.max(ANCHOR_MIN_BOTTOM, Math.round(height - safePanel - ANCHOR_MIN_TOP))

  return Math.max(ANCHOR_MIN_BOTTOM, Math.min(wanted, ceiling))
}

/**
 * 面板贴到输入区上方的**完整位置**（垂直 + 水平）。
 *
 * 为什么水平也要量：面板原来是在**窗口**里居中（`justify-center`），
 * 而输入区是在**对话列**里居中 —— 左右栏宽度不一样，两个中心就差开了
 * （实测差 60px）。所以左边和宽度都得从输入区的 rect 拿。
 */
export function anchoredPlacement(
  composer: { top: number; left: number; width: number },
  viewport: { width: number; height: number },
  panelHeight = 0,
): { bottom: number; left: number; width: number } {
  const width = Math.max(0, Math.round(Number(composer.width) || 0))
  const leftRaw = Math.round(Number(composer.left) || 0)
  /* 输入区比窗口还宽时（不应该发生）就贴左边、占满窗口 */
  const maxWidth = Math.max(0, Math.round(Number(viewport.width) || 0))
  const finalWidth = maxWidth > 0 ? Math.min(width, maxWidth) : width
  const left = Math.max(0, Math.min(leftRaw, Math.max(0, maxWidth - finalWidth)))

  return {
    bottom: anchoredBottom(composer.top, viewport.height, panelHeight),
    left,
    width: finalWidth,
  }
}

/**
 * 面板贴上去之后还剩多少可用高度 —— 给「要不要限高」用。
 * 比 `anchoredBottom` 早一轮就能算出来：先按输入区顶边算一个上限，
 * 免得面板先渲染成很高、下一帧再被压下去（会闪）。
 */
export function anchoredMaxHeight(composerTop: number, reserve = 24): number {
  const top = Number(composerTop)
  if (!Number.isFinite(top)) return 0
  return Math.max(0, Math.round(top - ANCHOR_GAP - reserve))
}
