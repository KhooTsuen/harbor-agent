import type { ClarifyReply, PermissionRequest } from '@/types'
import { useUIStore } from '@/stores/useUIStore'
import { ClarifyCard } from './ClarifyCard'
import { GateCard } from './GateCard'
import { clarifyReplyDetails } from '@/lib/inputReplyDetails'
import type { SubmitInputCard } from './useInputCardReplies'
import { useFallbackCardReply } from './useFallbackCardReply'
import { InputCardReceipt } from './InputCardReceipt'

/* ══════════════════════════════════════════════════════════════
    澄清卡的挂载点（AG-053）

    从卡槽接收请求并交给卡片；答复经卡槽保留本次回执，
    卡片本身仍只负责选择与补充内容。

    ★ 2026-10-07：多一个分流 —— 内核带 `gate: true` 上来的是「执行前的计划复核」，
      出口与普通澄清不同（见 `GateCard`），所以走另一张卡。

    ⚠️ 为什么不在这里判「该不该显示」：那张卡和权限条的先后由
       `lib/clarify.ts` 仲裁，判断只在一处（`AboveInputCards` 用它决定谁 hidden）。
    ══════════════════════════════════════════════════════════════ */

export function ClarifySlot({
  request: providedRequest,
  onSubmit,
}: {
  request?: PermissionRequest | null
  onSubmit?: SubmitInputCard
} = {}) {
  const storedRequest = useUIStore((state) => state.clarify)
  const clarify = providedRequest === undefined ? storedRequest : providedRequest
  const fallback = useFallbackCardReply(clarify)
  if (!clarify?.clarify || clarify.clarify.length === 0) return null
  if (!onSubmit && fallback.reply)
    return <InputCardReceipt reply={fallback.reply} canRetry onDismiss={fallback.dismiss} />

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
  const onReply = (reply: ClarifyReply) => {
    const submit = onSubmit ?? fallback.submit
    submit(
      clarify,
      clarifyReplyDetails(reply),
      clarify.onClarify ? () => clarify.onClarify?.(reply) : undefined,
    )
  }

  /* A 闸门（2026-10-07）：执行前的计划复核 → 只出两个明确出口的那张卡（见 GateCard） */
  if (clarify.gate === true) {
    return <GateCard key={key} questions={questions} onReply={onReply} />
  }

  return <ClarifyCard key={key} questions={questions} onReply={onReply} />
}
