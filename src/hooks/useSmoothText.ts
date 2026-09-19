import { useEffect, useRef, useState } from 'react'

/* ══════════════════════════════════════════════════════════════
   AG-023：把流式的文字「摊平」到每一帧

   ── 要解决的问题 ──

   真机量出来两件事：

     上游：611 个 chunk（每个 1~2 字，逐 token）
     到达：**不均匀** —— 有的间隔 51ms，有的 428ms、1187ms

   那 1.2 秒的空档不是我们的锅（SSE 缓冲 / 网络抖动），但**后果是界面上
   一大块字突然刷出来**，读起来是「一顿一顿」，不是流水。

   后端那边已经修了一处真 bug（见 `stream-batch.cjs`：定时器被主进程
   事件循环推迟到 1.1 秒），但**上游不均匀这件事后端救不了** ——
   只能在前端把不均匀的批次**摊到帧上**。

   ── 做法 ──

   `shown` 慢慢追 `target`：每帧最多前进 `gap / 10`（至少 1 个字）。
   差得多就追得快，追上就停 —— 所以：

     · 上游一次给 588 字 → 界面上是两秒里匀速流出来的
     · 上游慢慢给       → 追上了就等，不会「倒欠」

   ── 三条纪律 ──

   1. **写完（`active=false`）必须立刻给全**。否则消息已经结束了，
      界面上还在慢慢打字，用户以为卡住了。
   2. **`target` 变化不能重启 rAF 循环**。所以 target 存在 ref 里，
      effect 只依赖 `active` —— 否则每来一批就重起一次循环。
   3. **追不上时要加速，不能无限滞后**。`gap / 10` 保证了这一点：
      差距越大每帧补得越多，最多滞后约 10 帧。
   ══════════════════════════════════════════════════════════════ */

/** 每帧最多补「剩余量的几分之一」—— 越小越平滑、追得越慢 */
const CATCH_UP_DIVISOR = 10

/**
 * 这一帧应该显示到第几个字。
 *
 * 抽成纯函数是为了能直接测（hook 本身要 React 环境，逻辑没必要绑在里面）。
 *
 * 规则：**追上就停**（返回 targetLen），没追上就补 `gap / 10`（至少 1 个）。
 *
 * 所以差距是按 0.9 指数收敛的：差 1 个字时一帧补 1 个（像打字机），
 * 差 588 个字时一帧补 59 个（约 1 秒追完）—— 差距越大追得越快。
 * 这样上游一次甩过来一大块也不会让界面「打半分钟字」。
 */
export function nextSmoothLength(currentLen: number, targetLen: number): number {
  if (currentLen >= targetLen) return targetLen
  const gap = targetLen - currentLen
  return currentLen + Math.max(1, Math.ceil(gap / CATCH_UP_DIVISOR))
}

export function useSmoothText(target: string, active: boolean): string {
  const [shown, setShown] = useState(target)
  const targetRef = useRef(target)
  const shownRef = useRef(target)
  const rafRef = useRef(0)

  /* target 每次变都更新 ref，但不重起循环（见纪律 2） */
  targetRef.current = target

  useEffect(() => {
    if (!active) {
      /* 纪律 1：写完了立刻给全 */
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      shownRef.current = targetRef.current
      setShown(targetRef.current)
      return
    }

    const tick = (): void => {
      const full = targetRef.current
      const cur = shownRef.current

      if (cur.length < full.length) {
        const next = full.slice(0, nextSmoothLength(cur.length, full.length))
        shownRef.current = next
        setShown(next)
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [active])

  /* 不流式时直接给 target，免得 ref 和 state 有一步滞后 */
  return active ? shown : target
}
