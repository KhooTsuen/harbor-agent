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
   ══════════════════════════════════════════════════════════════ */

export function AboveInputCards() {
  const permission = useUIStore((s) => s.permission)
  const clarify = useUIStore((s) => s.clarify)
  const winner = pickAboveInput({
    permission: permission !== null,
    clarify: clarify !== null,
  })

  return (
    <>
      <div hidden={winner !== 'permission'}>
        <PermissionBar />
      </div>
      <div hidden={winner !== 'clarify'}>
        <ClarifySlot />
      </div>
    </>
  )
}
