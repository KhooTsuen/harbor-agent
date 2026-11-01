import { anchorAligned, anchorTop, findAnchorEl, type MessageAnchor } from './scrollAnchor'

/* ══════════════════════════════════════════════════════════════
   切回对话时「把锚点放回原来的行」—— 一步一次，直到真的对上

   为什么单独一个文件：这段判据要在三种时机重复用（ResizeObserver、
   每次提交后的 layout effect、容器晚挂载），而它全是「读几何 + 下结论」，
   跟 React 无关。抽成纯函数，`hooks/useAutoScroll.ts` 才留得下滚动状态机本身
   （单文件 300 行红线）。

   三条结论：
     · stale —— 这份恢复不属于当前对话（A→B→A 连切时的旧任务），必须扔掉
     · wait  —— 目标消息还没进渲染窗口，或者落点还差着（内容不够高被 clamp）。
                **什么都不写、也不许宣告成功** —— 此刻能用的像素位置可能正好
                对应另一段内容，按它落位就是「碰巧可用」而不是「回到原位」
     · done  —— 锚点真的落回离开时那一行（±WRITE_EPSILON）

   没有锚点时（还没有消息锚点的老状态 / 极短对话）才退回像素：
   装得下才算完，装不下就等长高。
   ══════════════════════════════════════════════════════════════ */

/** 程序落点 / 锚点位移的比对容差（浏览器会把坐标抹成小数）—— 全项目一处口径 */
export const WRITE_EPSILON = 0.5

export interface PendingRestore {
  /** 这份恢复属于哪条对话 —— 落到别的对话上就是串台 */
  threadId: string
  /** 视野顶那条消息；null = 没有锚点，退回 `top` */
  anchor: MessageAnchor | null
  top: number
}

export type RestoreOutcome = 'done' | 'wait' | 'stale'

/**
 * 试一次落位。
 * `write` 是唯一允许改视图的入口（调用方负责记落点、认领 scroll 事件）。
 */
export function restoreStep(
  sc: HTMLElement,
  content: HTMLElement | null,
  pending: PendingRestore,
  currentThread: string,
  write: (top: number) => void,
): RestoreOutcome {
  if (pending.threadId !== currentThread) return 'stale'
  if (!pending.anchor || !content) {
    write(pending.top)
    return pending.top <= sc.scrollHeight - sc.clientHeight + WRITE_EPSILON ? 'done' : 'wait'
  }
  const target = findAnchorEl(content, pending.anchor)
  /* 目标还没进窗口：不写视图。等 MessageList 把窗口扩到盖住它 */
  if (!target) return 'wait'
  /*
   * 目标元素还没有高度 = 这一帧还没真正布局（测试里是「还没铺尺子」，真机上是
   * 图片/懒内容还没撑开）。此时算出来的偏移必然等于 0，而窗口第一条恰好就会
   * 「对上」—— 那是**假成功**：等它真长出来，用户已经被丢在别处了。
   */
  if (target.getBoundingClientRect().height <= 0) return 'wait'
  write(anchorTop(sc, target, pending.anchor))
  return anchorAligned(sc, target, pending.anchor) ? 'done' : 'wait'
}
