import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   右栏标签上的两种「点」—— 形状与颜色**必须一眼分清**（Phase 2）

   它们表达的是两种完全不同的意思，混了就会误导：

     · ContentDot 「有内容」 —— 中性信息：那个标签里有东西可以看。
       **空心环 + 中性色**（--text-tertiary）。它不代表任何问题，
       不该被读成警告。
     · UnreadDot  「未读的严重错误」 —— 需要你处理：P0/P1 错误你还没看过。
       **实心圆点 + 状态色**（P0 失败色 / P1 警告色，走 statusLanguage）。

   为什么要分这么细：错误那个点是**红色实心圆**，如果「有内容」也用实心圆 / 红橙系，
   用户会把「有个成果躺在里面」当成「出错了」。所以形状（空心 vs 实心）和
   颜色（中性 vs 状态色）**两个维度都要不一样** —— 这是本阶段的一条硬要求。

   两种点只在 `RightTabs` 里用；把定义放一处，改的时候不会两边各改一半。
   ══════════════════════════════════════════════════════════════ */

/** 「有内容」：空心环 + 中性色。不是警告，只是「里面有点东西，可以看看」 */
export function ContentDot() {
  return (
    <span
      aria-hidden
      className="absolute right-0.5 top-0.5 size-2 rounded-full border"
      style={{ borderColor: 'var(--text-tertiary)' }}
    />
  )
}

/** 「未读的严重错误」：实心点 + P0/P1 状态色（与顶栏兜底同一份颜色来源） */
export function UnreadDot({ worst }: { worst: 'P0' | 'P1' | null }) {
  return (
    <span
      aria-hidden
      className="absolute right-0.5 top-0.5 size-1.5 rounded-full"
      style={{ background: colorOf(worst === 'P0' ? 'failed' : 'warning') }}
    />
  )
}
