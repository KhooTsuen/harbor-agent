import { clarifyReplyToWire } from '@/lib/clarify'
import type { ClarifyQuestion, StoredClarify } from '@/types'
import { useUIStore } from '../useUIStore'
import { useAppStore } from '../useAppStore'
import { submitCardReply } from './inputReplies'
import { clarifyReplyDetails } from '@/lib/inputReplyDetails'
import { prepareConfirmationPause } from './confirmationPause'
export { applyPauseAfterTurn } from './confirmationPause'

/* ══════════════════════════════════════════════════════════════
   写操作确认（主进程推过来的 `confirm_request`）

   从 `streamEvents.ts` 搬出来的（那边贴着 300 行红线）。这一段自成一体：
   收到事件 → 把主进程的请求翻成人话 → 弹窗 → 用户点完回话。
   它和「内容 / 工具怎么落到消息上」是两件事，放在一起只会互相挤。

   ⚠️ 搬走时唯一的风险是**接线**。本项目真的踩过：在主流程里留个空函数占位，
   tsc 全绿、lint 全过、测试全过，但功能整个没了（见 docs/踩坑记录.md 坑 #2）。
   所以 `streamEvents.ts` 里那个 case 必须**真的调用**这里 —— 那条接线由
   `__tests__/permissionDiff.test.ts` 盯着（它走的是 `handleStreamEvent`）。
   ══════════════════════════════════════════════════════════════ */

/** 工具种类 → 用户看得懂的说法 */
const KIND_TEXT: Record<string, string> = {
  write: '修改文件',
  mcp: '调用外部工具',
  risk: '执行命令',
  path: '访问工作目录之外的文件',
}

/**
 * AG-013：把「要不要允许」说成人话，并且**说清「本次」的范围**。
 * 以前的标题是「模型请求执行：run_shell」—— 那是内部名字，
 * 用户既看不懂、也不知道批了之后会发生什么。
 */
export function askPermissionFor(event: Record<string, unknown>): void {
  const confirmId = String(event.confirmId ?? '')
  const toolName = String(event.toolName ?? '操作')
  const kind = String(event.kind ?? '')

  /*
   * AG-053 / P0-5：开工前澄清走**另一张卡**。
   *
   * 它复用同一条 `chat:confirm` 通道（不开新通道），但回话带解释（不是布尔），
   * 所以在这里分流：进 `clarify` 槽位，而不是权限那个 `permission` 槽位 ——
   * 两个槽位由 `lib/clarify.ts` 的 `pickAboveInput` 仲裁谁显示（永不叠）。
   *
   * ★ 判据是主进程给的 `decisionType`（'approval' | 'clarify'），**不再靠 `kind` 猜**
   *   —— 审批的 `kind` 是工具种类（write/mcp/…）、澄清的 `kind` 恒为 'clarify'，
   *   同一个字段名两套值域（硬约束 9 要消灭的）。老版本主进程没带 `decisionType`
   *   时退回看 `kind`（兼容）：界面不会因为主进程先后端升级而失能。
   */
  const decisionType = String(event.decisionType ?? '')
  if (decisionType === 'clarify' || (decisionType === '' && kind === 'clarify')) {
    const questions = Array.isArray(event.questions) ? event.questions : []
    useUIStore.getState().askClarify({
      confirmId,
      kind: 'clarify',
      /*
       * A 闸门（2026-10-07）：这一张是「执行前的计划复核」而不是普通澄清 ——
       * 卡片据此只出「执行 / 先别动」两个出口（见 `components/chat/GateCard`）。
       * 标记由内核 `tools/ask-user-gate.cjs` 带上来，这里如实透传。
       */
      gate: event.gate === true,
      title: '动手前先对齐一下',
      description: '',
      confirmText: '就这么干',
      danger: false,
      /* 这张卡属于哪条对话 —— 切走时要收的是它（见 useAppStore.setActiveThread） */
      threadId: String(event.sessionId ?? event.threadId ?? ''),
      clarify: questions as ClarifyQuestion[],
      onClarify: async (reply) => {
        const settlePause = reply.cancelled ? await prepareConfirmationPause(event) : undefined
        const accepted = await submitCardReply(
          event,
          reply.skipped !== true,
          clarifyReplyDetails(reply),
          clarifyReplyToWire(reply),
          {
            questions: questions as ClarifyQuestion[],
            answers: reply.answers,
            skipped: reply.skipped === true,
            cancelled: reply.cancelled,
            rephrase: reply.rephrase,
          },
        )
        settlePause?.(accepted.ok)
        if (!accepted.ok) return accepted
        useUIStore.getState().closeClarify(confirmId)
        return accepted
      },
      /* 卡片被外部关掉（切对话、任务停了、用户按 Esc）：当「跳过」回话，
         不能让主进程干等到超时 —— 那样它会以为用户离场了 */
      onCancel: () => submitCardReply(event, false, ['已关闭提问卡，本次未答复']),
    })
    return
  }

  const risk = (event.risk ?? null) as { level?: string } | null
  const high = risk?.level === 'high'
  /*
   * 和 core/tools/approval.cjs 的 REMEMBERED 保持一致（那里只有 `write`）。
   * ★ `mcp` 2026-11-05 第二轮移出：内核已经**完全不记** MCP 的批准
   *   （能力分级不可靠，一次确认只能授权它显示的那一次调用）。这里要是还留着
   *   `mcp`，卡片会写着「同意后，本轮内同类操作不再询问」—— 与实际行为相反，
   *   用户按那句话预期不会再被问，结果每次都要点，反而以为卡坏了。
   * ★ 但 `alwaysAsk`（Codex 经 MCP 的写路径，逐次审批）时**必须为 false** ——
   *   那种情况卡片上说「本轮内同类不再询问」是**反的**（用户第 3 条）。
   */
  const remembered = kind === 'write' && event.alwaysAsk !== true
  const alwaysAsk = event.alwaysAsk === true
  /*
   * MCP 的「不会记住」要说在明面上：它和 `alwaysAsk` 是两回事
   * （后者是 Codex 写路径的逐次审批标志），但卡片上要传达的是同一句话。
   */
  const perCall = kind === 'mcp' && !alwaysAsk

  useUIStore.getState().askPermission({
    /*
     * ★ 必须带上它：`confirm.timeout` 收卡走的是 `closePermission(confirmId)` 精确匹配，
     *   卡上没有 confirmId 就永远匹配不上、清不掉（澄清卡一直带着它，审批这条漏了）。
     *   2026-10-07 真机复现：permission.confirmId 为 undefined，超时事件形同虚设。
     */
    confirmId,
    kind: 'run-command',
    title: high
      ? `⚠ 高风险：${KIND_TEXT[kind] ?? toolName}`
      : `Agent 准备${KIND_TEXT[kind] ?? `执行 ${toolName}`}`,
    description: [
      String(event.summary ?? ''),
      remembered ? '同意后，「本轮」内同类操作不再询问。' : '',
      perCall ? '外部工具不受本应用控制，「这一次」的同意只对这一次调用有效（下次还会问）。' : '',
      alwaysAsk
        ? '这是外部 Codex 经 MCP 发起的写入，「每一次都会单独询问」（不会记住本次同意）。'
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    confirmText: '允许本次',
    danger: high,
    /* AG-036：会改成什么样（没有就不传，弹窗里也不会出现「查看 Diff」） */
    diff: Array.isArray(event.diff) ? event.diff : undefined,
    diffNote: String(event.diffNote ?? ''),
    impact: Array.isArray(event.impact) ? event.impact.map(String) : [],
    /* 这张卡属于哪条对话 —— 切走 / 停任务 / 轮末要收的是它（和澄清卡一样） */
    threadId: String(event.sessionId ?? event.threadId ?? ''),
    onConfirm: () => submitCardReply(event, true, ['已选择：允许本次操作']),
    /* 关掉弹窗也算拒绝 —— 不回话的话主进程会一直等到超时 */
    onCancel: () => submitCardReply(event, false, ['已选择：拒绝本次操作']),
  })
}

/**
 * 把「开工前问过什么 + 是怎么定的」记到这一轮的助手消息上（AG-053 批③）。
 *
 * 为什么记在**助手消息**而不是用户消息：用户那条在按下发送时就落盘了（追加式写，
 * 没地方原地更新），而助手那条是这一轮**收尾时**才落的 —— 这时候答复早就有了。
 * 一起落盘还顺带解决了「重开会话看得见」：只读卡读的就是这个字段。
 *
 * 找不到助手消息（老对话 / 消息被切走）就**安静地什么都不做** ——
 * 这只影响「以后回看」，不该让这一轮出别的毛病。
 */
function recordClarify(event: Record<string, unknown>, outcome: StoredClarify): void {
  /*
   * ⚠️ 主进程那条事件里带的是 `sessionId`（不是 threadId）——
   *   两个 id 在这个项目里是同一个东西（对话就是会话），但**字段名不一样**，
   *   写错就等于默默不记（批③ 真机跑第一遍就是这样：卡都过了，磁盘上一片空白）。
   */
  const threadId = String(event.sessionId ?? event.threadId ?? '')
  if (!threadId) return
  const messages = useAppStore.getState().threads.find((t) => t.id === threadId)?.messages ?? []
  const execution = String(event.requestId ?? '')
  const last = messages.find((m) => m.role === 'assistant' && m.execId === execution)
  if (!last) return
  useAppStore.getState().updateMessage(threadId, last.id, { clarify: outcome })
}

/**
 * 卡「超时作废」—— 两类卡共用这一条（主进程推来）。
 *
 *   · `clarify.timeout`（AG-053 批③）：用户走开太久，任务按**默认选项**继续。
 *     收卡 **+ 记进消息**（`auto: 'timeout'`）—— 回看时知道哪几条是替他定的。
 *   · `confirm.timeout`（2026-10-07）：审批卡 5 分钟没答复，任务按**拒绝**继续。
 *     只收卡。以前没有这条，卡会在界面上烂着，而 `pickAboveInput` 永远让权限
 *     优先 —— 后面**所有澄清卡都被它挡住**，用户「收不到提问卡」、界面一直
 *     「正在进行中」（真机复现见 CHANGELOG）。不回话：主进程已经结算了。
 *
 * 都按 confirmId 精确收：同一对话里可能已经换成下一张卡了，不能无条件关。
 */
export function onCardTimeout(event: Record<string, unknown>): void {
  const confirmId = String(event.confirmId ?? '')
  if (String(event.type ?? '') === 'confirm.timeout') {
    useUIStore.getState().closePermission(confirmId || undefined)
    return
  }
  const pending = useUIStore.getState().clarify
  useUIStore.getState().closeClarify(confirmId)
  /* 卡上那几个问题就是回看要显示的东西（只认**当前这张**，别的卡不动） */
  const questions = pending?.confirmId === confirmId ? (pending.clarify ?? []) : []
  recordClarify(event, { questions, answers: [], skipped: true, auto: 'timeout' })
}

/**
 * 一轮结束了（done / aborted / error）：把**这条对话**还挂着的权限卡收掉。
 *
 * 主进程在 finally 里已经 `closeOut(requestId)` 把这一轮的确认按拒绝结算了，
 * 界面只是还没跟上（它永远等不到下一次点击）。按 threadId 认领 —— 别的对话
 * 可能也挂着一张卡，那不归这次收尾管。
 */
export function clearPermissionForThread(threadId: string): void {
  const id = String(threadId ?? '')
  if (!id) return
  const cur = useUIStore.getState().permission
  if (cur && cur.threadId === id) useUIStore.getState().closePermission()
}
