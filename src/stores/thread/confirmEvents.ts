import { confirmChat } from '@/lib/backend'
import { clarifyReplyToWire } from '@/lib/clarify'
import type { ClarifyQuestion, StoredClarify } from '@/types'
import { useUIStore } from '../useUIStore'
import { useAppStore } from '../useAppStore'

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
   * AG-053：开工前澄清走**另一张卡**。
   *
   * 它复用同一条 `chat:confirm` 通道（不开新通道），但回话带解释（不是布尔），
   * 所以在这里分流：进 `clarify` 槽位，而不是权限那个 `permission` 槽位 ——
   * 两个槽位由 `lib/clarify.ts` 的 `pickAboveInput` 仲裁谁显示（永不叠）。
   */
  if (kind === 'clarify') {
    const questions = Array.isArray(event.questions) ? event.questions : []
    useUIStore.getState().askClarify({
      confirmId,
      kind: 'clarify',
      title: '动手前先对齐一下',
      description: '',
      confirmText: '就这么干',
      danger: false,
      clarify: questions as ClarifyQuestion[],
      onClarify: (reply) => {
        useUIStore.getState().closeClarify(confirmId)
        void confirmChat(confirmId, reply.skipped !== true, clarifyReplyToWire(reply))
        /* 记到这一轮的助手消息上（那是以后回看时的只读卡） */
        recordClarify(event, {
          questions: questions as ClarifyQuestion[],
          answers: reply.answers,
          skipped: reply.skipped === true,
        })
      },
      /* 卡片被外部关掉（切对话、任务停了、用户按 Esc）：当「跳过」回话，
         不能让主进程干等到超时 —— 那样它会以为用户离场了 */
      onCancel: () => void confirmChat(confirmId, false),
    })
    return
  }

  const risk = (event.risk ?? null) as { level?: string } | null
  const high = risk?.level === 'high'
  /* 和 core/tools/approval.cjs 的 REMEMBERED 保持一致 */
  const remembered = kind === 'write' || kind === 'mcp'

  useUIStore.getState().askPermission({
    kind: 'run-command',
    title: high
      ? `⚠ 高风险：${KIND_TEXT[kind] ?? toolName}`
      : `Agent 准备${KIND_TEXT[kind] ?? `执行 ${toolName}`}`,
    description: [
      String(event.summary ?? ''),
      remembered ? '同意后，**本轮**内同类操作不再询问。' : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    confirmText: '允许本次',
    danger: high,
    /* AG-036：会改成什么样（没有就不传，弹窗里也不会出现「查看 Diff」） */
    diff: Array.isArray(event.diff) ? event.diff : undefined,
    diffNote: String(event.diffNote ?? ''),
    impact: Array.isArray(event.impact) ? event.impact.map(String) : [],
    onConfirm: () => void confirmChat(confirmId, true),
    /* 关掉弹窗也算拒绝 —— 不回话的话主进程会一直等到超时 */
    onCancel: () => void confirmChat(confirmId, false),
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
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!last) return
  useAppStore.getState().updateMessage(threadId, last.id, { clarify: outcome })
}

/**
 * 主进程推来的「离场超时」（AG-053 批③）：用户走开太久，任务按**默认选项**继续了。
 *
 * 要做两件事，缺一件用户回来就懵：
 *   ① **把卡收起来** —— 否则他看到的是一张还在等他的卡，而任务早跑完了；
 *   ② **把这件事记进消息**（`auto: 'timeout'`）—— 回看时知道哪几条是替他定的。
 *
 * 按 confirmId 精确收：同一对话里可能已经换成下一张卡了，不能无条件关。
 */
export function onClarifyTimeout(event: Record<string, unknown>): void {
  const confirmId = String(event.confirmId ?? '')
  const pending = useUIStore.getState().clarify
  useUIStore.getState().closeClarify(confirmId)
  /* 卡上那几个问题就是回看要显示的东西（只认**当前这张**，别的卡不动） */
  const questions = pending?.confirmId === confirmId ? (pending.clarify ?? []) : []
  recordClarify(event, { questions, answers: [], skipped: true, auto: 'timeout' })
}
