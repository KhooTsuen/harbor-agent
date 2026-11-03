import type { ReasoningLevel, RightTab, ThemePreference, ThreadMode } from './index'

/* ══════════════════════════════════════════════════════════════
   设置的类型（含默认值口径）
 
   从 `index.ts` 搬出来的：那边**正好 300 行顶格**（行数红线的上限），
   再加一个字段就超。搬而不是拆着留一半，是因为「设置」本来就有一个
   清楚的边界 —— 它全是渲染层的界面偏好，没有一条被内核读取。
 
   ★ 搬家用的是**整体搬 + index.ts 再导出**：外面 `import { Settings } from '@/types'`
   一个都不用改。这和 `notify.ts` / `permission.ts` 的做法一致。
   ══════════════════════════════════════════════════════════════ */

export type FontFamilyId = 'system' | 'yahei' | 'pingfang' | 'sfpro' | 'noto' | 'harmony' | 'custom'
export type ASCIIQuality = 'high' | 'medium' | 'low' | 'static'

/* ── 通知的去向（用户按类别自己选）────────────────────────────
 *
 * 病根：右下角那块以前混装了三类性质完全不同的东西 ——
 *   ① 要你现在处理（出错 / 要拍板）
 *   ② 事后看就行（任务跑完 / 下载完成）
 *   ③ 过程播报（正在重试 / 换了供应商 / Agent 在动网页）
 * ②③ 把 ① 挤没了，这就是「碍眼」的真正来源。所以给 ②③ 一个收件箱，
 * 让 ① 独占右下角 —— 而不是把所有提示调小或调快。
 */

/** 一条通知该去哪儿 */
export type NotifyRoute =
  /** 右下角弹一张卡（几秒后自己消失） */
  | 'toast'
  /** 不弹，只进右栏「通知」标签 */
  | 'center'
  /** 都不要：不弹、也不记 */
  | 'off'

/**
 * 通知的类别。**按「用户此刻要不要处理」分，不按文案长短分。**
 *
 * ★ 这个分类是唯一真相源：分流（`lib/notifyCenter.ts`）和面板上的
 *   设置项都读它，两边不许各写一套。
 */
export type NotifyCategory =
  /** 出错了 / 失败了 —— 需要你知道，可能还要看日志 */
  | 'error'
  /** 在等你处理（权限确认、澄清提问、敏感文件访问）—— 不处理就走不下去，或者你该马上知道 */
  | 'needYou'
  /** 任务跑完了（成功 / 失败 / 取消） */
  | 'task'
  /** 下载开始 / 完成 / 失败 */
  | 'download'
  /** Agent 的过程播报（正在重试、换了供应商、上下文太长、在动网页） */
  | 'agent'
  /** 其余日常确认（已保存 / 已复制 / 已加入队列）—— 多半是你自己刚点的 */
  | 'info'

export type NotifyRoutes = Record<NotifyCategory, NotifyRoute>

/* ── 设置本体 ───────────────────────────────────────────────── */

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
  /** 输入框高度（px）：面板上沿可拖，拖完就固定在那个高度；纯界面状态，只进 localStorage */
  composerHeight: number
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
  /**
   * 设置页的详细程度（P2 #1）：`simple` = 只列常用项，`detailed` = 全量。
   *
   * ★ 只改变**展示层次** —— 两种视图共用同一份配置，切换不重置、不另存。
   *   简洁视图里仍在生效的专业项会在顶部点名提示，不让它悄悄生效。
   */
  settingsView: 'simple' | 'detailed'
  /**
   * 每轮结束后显示任务结果摘要卡（P2 #30）。**默认关闭**。
   *
   * 关着的时候完全不生成摘要卡；开着时按真实任务台账显示完成/失败/取消、
   * 改动文件数和检查结论 —— 不按模型自述判断成败。
   */
  taskSummary: boolean
  /* ── 提示 ── */
  /** 保留「重要通知记录」（右下角历史按钮，最多 100 条，仅本次打开期间）。
   *  默认开 = 与加这个开关之前一致；关掉后不再累积、按钮不出现，重开从零积累。
   *  只管「记录」：error / warning 的即时提示照常弹（那是另一件事）。 */
  noticeHistory: boolean
  /**
   * 每一类通知去哪儿（`toast` 右下角弹 / `center` 只进通知标签 / `off` 都不要）。
   *
   * ★ 默认值就是「右下角只弹要你处理的事」：
   *   error / needYou / info 弹（info 多是你自己刚点的操作，不弹等于没反馈）；
   *   task / download / agent 只进通知标签（那时你看别处，弹出来只会打断）。
   * ★ 少了某一类（老版本升上来）由 `lib/notifyCenter.ts` 的 `normalizeRoutes` 补默认，
   *   不在这里写判断 —— 那种「合并两份真相」的写法漂过一次。
   */
  notifyRoutes: NotifyRoutes
  /* ── 启动 ── */
  /**
   * 启动动画（启动页）开关：关掉后跳过整段动画直接进主界面。
   * 播放中点任意处可跳过，与这个开关是两回事。
   */
  bootAnimation: boolean
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
