import { useUIStore } from '@/stores/useUIStore'
import { ClarifyCard } from './ClarifyCard'

/* ══════════════════════════════════════════════════════════════
   澄清卡的挂载点（AG-053）

   只管「从 store 拿请求 → 交给卡片」这一件事，把订阅留在组件里、
   卡片本身保持纯（测试直接渲染卡片即可，不用搭 store）。

   ⚠️ 为什么不在这里判「该不该显示」：那张卡和权限条的先后由
      `lib/clarify.ts` 仲裁，判断只在一处（`AboveInputCards` 用它决定谁 hidden）。
   ══════════════════════════════════════════════════════════════ */

export function ClarifySlot() {
  const clarify = useUIStore((s) => s.clarify)
  if (!clarify?.clarify || clarify.clarify.length === 0) return null

  return <ClarifyCard questions={clarify.clarify} onReply={(reply) => clarify.onClarify?.(reply)} />
}
