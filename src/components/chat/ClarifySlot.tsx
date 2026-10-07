import { useUIStore } from '@/stores/useUIStore'
import { ClarifyCard } from './ClarifyCard'
import { GateCard } from './GateCard'

/* ══════════════════════════════════════════════════════════════
    澄清卡的挂载点（AG-053）

    只管「从 store 拿请求 → 交给卡片」这一件事，把订阅留在组件里、
    卡片本身保持纯（测试直接渲染卡片即可，不用搭 store）。

    ★ 2026-10-07：多一个分流 —— 内核带 `gate: true` 上来的是「执行前的计划复核」，
      出口与普通澄清不同（见 `GateCard`），所以走另一张卡。

    ⚠️ 为什么不在这里判「该不该显示」：那张卡和权限条的先后由
       `lib/clarify.ts` 仲裁，判断只在一处（`AboveInputCards` 用它决定谁 hidden）。
    ══════════════════════════════════════════════════════════════ */

export function ClarifySlot() {
  const clarify = useUIStore((s) => s.clarify)
  if (!clarify?.clarify || clarify.clarify.length === 0) return null

  /*
   * ★ 2026-10-04：`key` 必须跟着**这一次请求**走。
   *
   * 卡片的勾选/补充是它自己的 useState。上一张卡答了一半（或者只勾了一项），
   * 主进程又推来下一张时，React 会**复用同一个组件实例** —— 新卡会继承旧卡的
   * `picked`/`notes`：如果两轮问了同样的问题文本，答案就串味了。
   *
   * 用 `confirmId`（每一次请求唯一）而不是问题文本当 key：问题重复时文本相同，
   * 拿文本当 key 等于没换 key —— 那正是这个 bug 的样子。
   */
  const key = clarify.confirmId ?? 'clarify'
  const questions = clarify.clarify
  const onReply = clarify.onClarify

  /* A 闸门（2026-10-07）：执行前的计划复核 → 只出两个明确出口的那张卡（见 GateCard） */
  if (clarify.gate === true) {
    return <GateCard key={key} questions={questions} onReply={onReply} />
  }

  return <ClarifyCard key={key} questions={questions} onReply={onReply} />
}
