import type { DiffFile } from './index'
import type { ClarifyQuestion, ClarifyReply } from './clarify'

/* ══════════════════════════════════════════════════════════════
   确认请求（PermissionRequest）—— 从 `types/index.ts` 搬出来的

   那个文件是公共类型的桶，AG-053 往里加了澄清的字段就顶到 310 行（硬约束 #2 是
   300）。搬出来的同时顺手把职责理顺：**这里是「上面那张卡要问用户什么」的唯一形状**，
   权限确认条 / 危险操作弹窗 / 澄清卡读的都是它。

   `onConfirm` 现在是**可选**的：澄清卡不用它（它自己带「就这么干」，因为它要带
   结构化答复回去），权限那侧照旧必填。
   ══════════════════════════════════════════════════════════════ */

export type PermissionKind =
  | 'run-command'
  | 'delete-thread'
  | 'delete-project'
  | 'clear-data'
  /* 任务面板里「清空这一组」的记录 */
  | 'clear-tasks'
  /* AG-052：撤销检查点之后的改动（破坏性，要二次确认 + 影响预览） */
  | 'rollback-checkpoint'
  /* AG-053：开工前澄清（要用户拿主意的地方，答完才动手） */
  | 'clarify'

export interface PermissionRequest {
  kind: PermissionKind
  /**
   * 主进程给这条请求的 id（`cfm_…` / `clr_…`）。
   * AG-053 批③ 用得上：离场超时的收卡事件是按这个 id 推上来的，
   * 收的时候得确认「就是这张卡」——同一条对话里可能已经换成下一张了。
   */
  confirmId?: string
  title: string
  description: string
  confirmText: string
  danger: boolean
  /** AG-036：这次会改成什么（写文件时才有）—— 弹窗里默认折叠，点开才看 */
  diff?: DiffFile[]
  impact?: string[]
  diffNote?: string
  /**
   * AG-053：澄清要问的问题（`kind === 'clarify'` 时才有）。
   * 每个选项都自带「因为 X 所以 Y」（`effect`），默认选项是 `defaultValue`。
   */
  clarify?: ClarifyQuestion[]
  /** 确认按钮（澄清卡不用它 —— 它自己带「就这么干」） */
  onConfirm?: () => void
  /** 取消/关闭时调（用于「写操作确认被拒绝」这种场景） */
  onCancel?: () => void
  /** AG-053：澄清卡答完之后回话（带用户选了什么、跳没跳） */
  onClarify?: (reply: ClarifyReply) => void
}
