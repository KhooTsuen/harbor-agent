import type { AgentPhase, Message, Project, Thread, ThreadMode, ThreadStatus } from '@/types'
import type { StoredMessage } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   useAppStore 的状态与动作签名

   抽出来有两个好处：
     · useAppStore.ts 保持在 300 行以内（规范要求）
     · 磁盘层的辅助函数可以引用同一个接口，不用把 store 整个拖进来
   ══════════════════════════════════════════════════════════════ */

export interface AppState {
  projects: Project[]
  threads: Thread[]
  activeProjectId: string
  activeThreadId: string

  /* 项目 */
  createProject: (name: string, path: string) => string
  deleteProject: (id: string) => void
  renameProject: (id: string, name: string) => void
  updateProjectMeta: (
    id: string,
    patch: { description?: string; icon?: string; color?: string },
  ) => void
  togglePinProject: (id: string) => void
  toggleArchiveProject: (id: string) => void

  /* 线程 */
  /**
   * 新建对话。
   * @param projectId 放进哪个文件夹；不传 = 用当前选中的；传 '' = 明确建「单独对话」
   * @param workdir   直接指定工作目录（用于挂到一个**还没出现在侧栏里**的新目录）
   */
  createThread: (projectId?: string, workdir?: string) => string
  /** 把某条对话挂到另一个目录（'' = 摘掉文件夹，变成单独对话） */
  setThreadWorkdir: (threadId: string, workdir: string) => Promise<void>
  replaceThreadId: (pendingId: string, realId: string) => void
  /** 删对话（连同它的任务历史）。返回清掉的任务条数 */
  deleteThread: (id: string) => Promise<number>
  renameThread: (id: string, title: string) => void
  /** 系统自动起的标题（保持 titleAuto = true，允许之后被更好的覆盖） */
  autoTitle: (id: string, title: string) => void
  setActiveThread: (id: string) => void
  setActiveProject: (id: string) => void
  togglePinThread: (id: string) => void
  toggleArchiveThread: (id: string) => void
  addThreadTag: (id: string, tag: string) => void
  removeThreadTag: (id: string, tag: string) => void
  markThreadExported: (id: string) => void

  /* 线程属性 */
  setThreadStatus: (id: string, status: ThreadStatus) => void
  /* AG-001：阶段由主进程状态机推过来，前端只负责记下 */
  setThreadPhase: (id: string, phase: AgentPhase) => void
  setThreadMode: (id: string, mode: ThreadMode) => void
  setThreadModel: (id: string, model: string) => void
  setThreadReasoning: (id: string, reasoning: Thread['reasoning']) => void
  branchThread: (threadId: string, messageId?: string) => string
  editUserMessage: (threadId: string, messageId: string, content: string) => void
  updateThreadSettings: (threadId: string, patch: NonNullable<Thread['settings']>) => void
  updateConversationState: (
    threadId: string,
    patch: Partial<NonNullable<Thread['conversationState']>>,
  ) => void

  /* 消息 */
  addMessage: (threadId: string, message: Message) => void
  updateMessage: (threadId: string, messageId: string, patch: Partial<Message>) => void
  removeMessage: (threadId: string, messageId: string) => void
  /** 把这条**之后**的消息都删掉（不含这条）—— 「编辑并重新回答」先丢掉对不上的旧回答 */
  removeMessagesAfter: (threadId: string, messageId: string) => void
  clearMessages: (threadId: string) => void

  /** 导入：合并线程与项目，磁盘模式下会写进 sessions/ */
  applyImport: (incoming: {
    threads: Thread[]
    projects: Project[]
  }) => Promise<{ threads: number; projects: number }>

  /* 维护 */
  resetAll: () => void

  /* 真实工作目录（Electron 下由主进程提供，浏览器里是空串） */
  workdir: string
  setWorkdir: (dir: string) => void

  /* ── 磁盘模式（Electron）─────────────────────────────────
   * 浏览器里这些全是空操作，数据和以前一样走内存 + localStorage。
   */
  /** 从 data/sessions/*.jsonl 读会话列表 */
  loadFromDisk: () => Promise<void>
  /** 读某个会话的完整消息（侧栏点开时调） */
  openFromDisk: (id: string) => Promise<void>
  /** 把一条消息写进 jsonl */
  persistMessage: (id: string, message: StoredMessage) => void
  /** 同步标题到 jsonl 的 meta 行 */
  persistMeta: (
    id: string,
    patch: {
      title?: string
      mode?: string
      model?: string
      threadSettings?: Record<string, unknown>
    },
  ) => void
}

/** 改完线程顺手更新 updatedAt —— 列表按它排序，不更新会一直沉在下面 */
export function touch(thread: Thread): Thread {
  return { ...thread, updatedAt: Date.now() }
}
