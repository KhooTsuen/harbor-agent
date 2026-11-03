/**
 * 消息区的**滚动盒子**：自动贴在底部（2026-11-03）
 *
 * ── 它解决什么 ────────────────────────────────────────────────
 *
 * 用户原话：「对话加载时应默认到对话最底部，我打开了好几次都要我手动滚动到底部」。
 * 以前 `ChatPanel` 里那个 `overflow-y-auto` 的 div **没有任何滚动管理** ——
 * 打开面板 `scrollTop` 就是 0，于是先看到的是这条会话最早那条消息。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────
 *
 * `ChatPanel.tsx` 已经贴着 300 行红线（硬约束 #2），多一行都放不下。
 * 而「贴底」这件事是**纯 DOM 行为**，与消息内容 / 流式状态都无关，
 * 正好整块搬出来。
 *
 * ── 为什么用 MutationObserver 而不是让上层传「消息变了」的信号 ──────
 *
 * 消息区里除了正文还有工具行、错误块、「用时 N 秒」这类异步出现的东西；
 * 谁在什么时候变，上层不一定都知道。直接看 DOM 才不漏。另外流式期间每片都追加
 * 一次，用观察者就自动跟上了，不用为「滚动」再往上一层层传 props。
 *
 * ── 什么时候不打扰你 ──────────────────────────────────────────
 *
 * **只有你本来就在底部时才跟着滚。** 你往上翻看历史时，新内容到达不会把你拽回
 * 底部 —— 那比不滚更烦人。判据是「离底部 < NEAR_BOTTOM_PX」，留一点余量，
 * 免得像素取整 / 缩放把「在底部」判成「不在」。
 *
 * ⚠️ `aria-label="消息流"` 这个锚点由调用方给（本组件只负责 `ref` 与滚动）。
 */

import { useEffect, useRef, type ReactNode } from 'react'

/** 离底部多近算「就在底部」（像素）—— 留余量，别让缩放/取整把判定翻掉 */
const NEAR_BOTTOM_PX = 48

/**
 * @param props.sessionKey 会话 id：**换了就强制贴底**（换了会话还停在上一条的位置没有意义）
 * @param props.className 布局类（`h-full overflow-y-auto …` 由调用方给，本组件不掺和样式）
 * @param props.label 无障碍名（调用方传 `消息流`，验收脚本靠它找容器）
 */
export function AutoscrollBox({
  sessionKey,
  className,
  label,
  children,
}: {
  sessionKey: string
  className?: string
  label?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  /** 此刻该不该跟着滚（用户上滑翻历史时置 false） */
  const stick = useRef(true)
  /** 上一次贴底时的会话 —— 变了就无条件贴一次 */
  const lastKey = useRef(sessionKey)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const toBottom = () => {
      /* 直接设 scrollTop 比 scrollTo({behavior:'smooth'}) 稳：平滑滚动在内容
         一秒里追加几十次时会互相打断，最后停在半路（真机上看到的就是这个）。 */
      el.scrollTop = el.scrollHeight
    }

    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      stick.current = gap <= NEAR_BOTTOM_PX
    }

    const follow = () => {
      if (stick.current) toBottom()
    }

    el.addEventListener('scroll', onScroll, { passive: true })

    /* 内容变了（新消息 / 流式追加 / 工具行晚到 / 高度变化）→ 在底部就跟上 */
    const mo = new MutationObserver(follow)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    const ro = new ResizeObserver(follow)
    ro.observe(el)

    /* 首帧：打开面板就该在最底部（等一帧让布局落定，再贴一次） */
    stick.current = true
    toBottom()
    const first = requestAnimationFrame(toBottom)

    return () => {
      cancelAnimationFrame(first)
      mo.disconnect()
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  /* 换会话：内容整批换掉、用户对新会话的预期就是「看最新的」 */
  useEffect(() => {
    if (lastKey.current === sessionKey) return
    lastKey.current = sessionKey
    stick.current = true
    const el = ref.current
    if (!el) return
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(id)
  }, [sessionKey])

  return (
    <div ref={ref} aria-label={label} className={className}>
      {children}
    </div>
  )
}
