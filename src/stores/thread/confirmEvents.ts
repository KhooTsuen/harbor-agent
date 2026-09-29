import { confirmChat } from '@/lib/backend'
import { useUIStore } from '../useUIStore'

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
