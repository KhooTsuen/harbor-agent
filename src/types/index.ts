/* ══════════════════════════════════════════════════════════════
   全局类型

   约定：不使用 any / ts-ignore / eslint-disable。
   外部数据（localStorage、用户输入、mock 数据）一律经过 type guard 收窄。
   ══════════════════════════════════════════════════════════════ */

/* ── 主题与外观 ─────────────────────────────────────────────── */

/* night（夜航）是彩蛋解锁的深色主题：连点左上角品牌标 5 次出现 */
export type ThemeName = 'default' | 'chatgpt' | 'spec' | 'light' | 'night'
export type ThemePreference = ThemeName | 'system'
export type ToggleState = 'on' | 'off'
/* 终端只在底栏（Ctrl+J）—— 右栏不再有终端标签，免得同一个东西两处入口 */
export type RightTab = 'diff' | 'files' | 'browser' | 'artifacts' | 'tasks' | 'state'
/**
 * Agent 生命周期阶段（AG-001）。
 *
 * **和主进程的 `electron/core/lifecycle.cjs` 必须一字不差** ——
 * 状态机的唯一真相源在那边，这里只是渲染层的类型。
 *
 * 老的 searching / reading / writing / compacting 已去掉：那些是**动作**不是**阶段**，
 * 属于 executing 期间的细节描述（AG-008 用 phaseLabel 说「正在读取相关文件…」）。
 */
export type AgentPhase =
  | 'idle'
  | 'preparing'
  | 'thinking'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'responding'
  | 'completed'
  | 'waiting_user'
  | 'paused'
  | 'retrying'
  | 'cancelled'
  | 'failed'

/** 旧的简化状态：只剩预览模式（mockTurn）在用，真后端一律看 phase */
export type ThreadStatus = AgentPhase | 'running' | 'success' | 'error' | 'waiting'
export type ThreadMode = 'plan' | 'pair' | 'execute' | 'goal'
export type ReasoningLevel = 'low' | 'high' | 'max'

/* ── 数据模型 ───────────────────────────────────────────────── */

export interface CodeBlock {
  id: string
  language: string
  code: string
  /** ```ts title="a.ts" 里的文件名，显示在语言标签位置 */
  filename?: string
  /** ```ts {1,3-5} 里要强调的行号（1 起） */
  highlightLines?: number[]
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

export interface TerminalLine {
  id: string
  type: 'input' | 'output' | 'error' | 'info'
  content: string
  timestamp: number
}

export interface FileNode {
  id: string
  name: string
  type: 'file' | 'folder'
  /** 相对工作目录的路径，用来读真实内容（Electron 下） */
  path?: string
  children?: FileNode[]
  content?: string
  language?: string
  /** 字节数，列表展示用 */
  size?: number
  modifiedAt?: number
}

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageKind = 'text' | 'code' | 'diff' | 'terminal' | 'error'
export type MessageStatus = 'sending' | 'streaming' | 'sent' | 'error'

export interface Citation {
  id: string
  kind: 'web' | 'file'
  title: string
  url?: string
  path?: string
  startLine?: number
  endLine?: number
  domain?: string
  snippet?: string
  fetchedAt?: number
}

export interface Artifact {
  id: string
  type: 'document' | 'code' | 'patch' | 'report' | 'generated_file'
  name: string
  path?: string
  taskId?: string
  sourceMessageId?: string
  createdAt: number
}

export interface Project {
  id: string
  name: string
  description: string
  /** 本地路径，纯展示 */
  path: string
  branch: string
  /** 项目图标（emoji 或图标名，只用于项目标识，不做装饰） */
  icon: string
  /** 颜色标签 id（只用于标识，不是 UI 主题色） */
  color: string
  pinned: boolean
  archived: boolean
  createdAt: number
  updatedAt: number
}

/* ── 设置 ──────────────────────────────────────────────────── */

export type FontFamilyId = 'system' | 'yahei' | 'noto' | 'harmony' | 'custom'
export type ASCIIQuality = 'high' | 'medium' | 'low' | 'static'

export interface Settings {
  theme: ThemePreference
  fontScale: number
  /** 界面字体（见 constants/fonts.ts 的字体栈表） */
  fontFamily: FontFamilyId
  /** fontFamily 选 custom 时用这个，只填字体名 */
  customFontFamily: string
  glassmorphism: boolean
  animations: boolean
  /** ASCII 海岛场景质量：只影响启动页，不影响 Agent */
  asciiQuality: ASCIIQuality
  /** 强制停掉 ASCII 场景的后台动画 */
  asciiReducedMotion: boolean
  sidebarWidth: number
  rightPanelWidth: number
  sidebarCollapsed: boolean
  /** 侧栏上下分栏：上半（对话文件夹）占的百分比 */
  sidebarFolderPercent: number
  rightPanelVisible: boolean
  defaultMode: ThreadMode
  defaultModel: string
  defaultReasoning: ReasoningLevel
  /** 新建对话时落在哪个项目 */
  defaultProjectId: string
  /** 发送方式：Enter 还是 Ctrl/Cmd+Enter */
  sendOnEnter: boolean
  /** 打字机速度倍率，0 = 立即显示 */
  typewriterSpeed: number
  language: 'zh' | 'en'
  /** 最近搜索历史（全局搜索用） */
  searchHistory: string[]
  /** 用户自定义快捷键，缺失项使用默认值 */
  shortcutKeys: Record<string, string>

  /* ── 上次的状态（重启后接着用）── */
  /** 上次打开的对话 */
  lastThreadId: string
  /** 上次在右栏哪个标签 */
  lastRightTab: RightTab
  /** 底部面板上次是开着的吗 */
  lastBottomPanelOpen: boolean
  /**
   * 任务中心看哪些任务：**只看当前项目**（默认，跟已有行为一致）还是**全部项目**。
   * 任务本身带 workdir，过滤在主进程做 —— 这里只决定要不要传。
   */
  taskScope: 'project' | 'all'
  /* ── 开屏的「性格层」与彩蛋（设计文档 §23）── */
  /**
   * 性格层（欢迎语/吐槽句）开关。关掉后开屏只保留状态层与动作层 ——
   * 重要的话不靠随机文案说，见 docs/Agent开屏与彩蛋设计方案.md §23.8。
   */
  persona: boolean
  /** 夜航主题解锁过（连点品牌标 5 次）。解锁后外观里会多出这个主题选项 */
  nightUnlocked: boolean
  /** 「航道畅通」触发过几次（只记次数，不记内容） */
  greenRuns: number
}

export type SettingsPatch = Partial<Settings>

/* ── 模型目录 ───────────────────────────────────────────────── */

export interface ModelOption {
  id: string
  label: string
  description: string
  /** 支持的推理等级 */
  reasoning: ReasoningLevel[]
}

/* ── 权限确认 ───────────────────────────────────────────────── */

export type PermissionKind =
  | 'run-command'
  | 'delete-thread'
  | 'delete-project'
  | 'run-command'
  | 'clear-data'
  /* 任务面板里「清空这一组」的记录 */
  | 'clear-tasks'

export interface PermissionRequest {
  kind: PermissionKind
  title: string
  description: string
  confirmText: string
  danger: boolean
  /** AG-036：这次会改成什么（写文件时才有）—— 弹窗里默认折叠，点开才看 */
  diff?: DiffFile[]
  impact?: string[]
  diffNote?: string
  onConfirm: () => void
  /** 取消/关闭时调（用于「写操作确认被拒绝」这种场景） */
  onCancel?: () => void
}

/* ── Toast ─────────────────────────────────────────────────── */

export type ToastKind = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  description?: string
  /**
   * AG-029：可选的行动按钮（例：任务结束后「查看结果」）。
   * 有动作的提示会多留一会儿 —— 4 秒来不及看清再点。
   */
  action?: { label: string; onClick: () => void }
}

/* ── 快捷键 ────────────────────────────────────────────────── */

export interface ShortcutDef {
  /** 动作 id，也是设置里可改的键 */
  id: string
  label: string
  /** 分组，设置页里分区展示 */
  group: string
  /** 默认组合，如 "mod+k" */
  defaultKeys: string
}

/* ── UI 预览回复类型（仅浏览器开发预览使用） ──────────────── */

export interface ReplyPayload {
  content: string
  kind: MessageKind
  codeBlocks?: CodeBlock[]
  diffs?: DiffFile[]
  terminalLines?: TerminalLine[]
}

/** UI 预览流式回调 */
export interface StreamHandlers {
  onChunk: (text: string) => void
  onDone: (payload: ReplyPayload) => void
  onError: (message: string) => void
}

/* 对话 / 消息 / 线程（从 index 拆出去，那边过 300 行了）*/
export * from './conversation'
