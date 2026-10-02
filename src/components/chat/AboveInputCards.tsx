import { useEffect, useRef } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { pickAboveInput } from '@/lib/clarify'
import { PermissionBar } from './PermissionBar'
import { ClarifySlot } from './ClarifySlot'

/* ══════════════════════════════════════════════════════════════
   输入框上方的卡片槽（AG-053）

   两件事只有一张能显示：**权限确认条** 和 **澄清卡**。仲裁在 `lib/clarify.ts`
   （`pickAboveInput`）：澄清让权限 —— 权限那条往返 5 分钟超时就当拒绝，不能被澄清压在后面）。

   ★ 不显示的那张**不卸载**，只用 `hidden` 收起来：用户可能在澄清卡上勾了一半
     选项，卸载会把勾的丢掉（那是另一种形式的丢数据）。React 会保留它的 state。

   ⚠️ 为什么单独一个组件：`Composer.tsx` 贴着 300 行红线，塞不进这段仲裁；
     而且「谁显示」是布局决策，和输入框本身没关系。

   ── P1-3：点了「需要你确认」的系统通知之后 ──
   用户点通知就是为了**这张卡**，所以这里负责把视线带过去：聚焦到卡上的第一个
   可点项 + 滚进视野（`scrollIntoView` 用 `nearest` —— 已经看得见就别乱滚，
   更不许碰消息区那套 FOLLOW/FREE 逻辑）。
   ══════════════════════════════════════════════════════════════ */

export function AboveInputCards() {
  const permission = useUIStore((s) => s.permission)
  const clarify = useUIStore((s) => s.clarify)
  const focusNonce = useUIStore((s) => s.cardFocusNonce)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const winner = pickAboveInput({
    permission: permission !== null,
    clarify: clarify !== null,
  })

  useEffect(() => {
    /* nonce 从 0 起：没被请求过就什么都不做（别在普通挂载时抢焦点）*/
    if (focusNonce <= 0) return
    const card = hostRef.current?.querySelector<HTMLElement>('section[aria-label]')
    if (!card) return
    const target = card.querySelector<HTMLElement>('button, input, textarea') ?? card
    target.focus()
    /*
     * 聚焦只是让键盘落上去；用户还得**看得见**它 —— 卡片可能被输入框挡住、
     * 或在窗口外。nearest = 已经在视野里就不动。
     */
    target.scrollIntoView({ block: 'nearest' })
  }, [focusNonce, winner])

  return (
    <div ref={hostRef}>
      <div hidden={winner !== 'permission'}>
        <PermissionBar />
      </div>
      <div hidden={winner !== 'clarify'}>
        <ClarifySlot />
      </div>
    </div>
  )
}
