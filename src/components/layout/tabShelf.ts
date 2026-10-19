/**
 * P3 #18：右栏标签栏「什么时候只放图标」的判据
 *
 * ── 要解决的问题 ────────────────────────────────────────────
 *
 * 标签栏以前是：**只有当前标签显示文字**，其余一律缩成 28px 的纯图标。
 * 那是为了塞进 380px 宽的右栏（八个标签全带文字会被挤成竖排单字）。
 *
 * 但文档的要求是「常用入口显示名称；空间不足时收纳进带名称的菜单」——
 * 纯图标堆叠正是它点名不要的形态：普通用户认不出哪个是「成果」哪个是「下载」。
 *
 * ── 现在的规则 ──────────────────────────────────────────────
 *
 * 常驻显示文字的只有**三个高频主入口**（审查 / 文件 / 任务）。它们每天都要点，
 * 值得占那点宽度。其余五个低频入口（成果 / 浏览器 / 下载 / 状态 / 错误）：
 *
 *   · 宽度够（`>= WIDE_THRESHOLD`）→ 也显示文字，一行排开
 *   · 宽度不够                     → 收进一个**带名字的「更多」菜单**
 *                                     （不是缩成无标签图标）
 *
 * ★ 收进菜单的入口**一个都不会丢**：菜单项本身带图标 + 文字，
 *   而且每条都有自己的 `aria-label`（键盘与读屏都能到）。
 * ★ 当前标签若落在菜单里，标签栏上仍会显示它的名字 —— 否则用户
 *   看不出「我现在在哪个面板」。
 *
 * 判据抽成纯函数是为了能直接测（宽度从参数进来，不读 window）。
 */

/** 这三个永远在标签栏上（常用入口，文档要求「显示名称」） */
export const PRIMARY_TABS = ['diff', 'files', 'tasks'] as const

/**
 * 宽度门槛（px）。
 *
 * 依据：右栏最小宽度 320、默认 380、拖宽可以到 720（见 `LAYOUT.rightPanel`）。
 * 三个主入口带文字约各需 62px，五个次级带文字约各需 58px，加上分隔线与
 * 关闭按钮 ≈ 8 × 60 + 40 ≈ 520。取 520 作为「全部带文字」的门槛；
 * 低于它就把次级那五个收进菜单，避免出现「挤成竖排单字」。
 */
export const WIDE_THRESHOLD = 520

export interface TabShelf<T> {
  /** 直接摆在标签栏上的 */
  inline: T[]
  /** 收进「更多」菜单的 */
  overflow: T[]
}

/**
 * 把标签分成「摆在栏上」和「收进菜单」两组。
 *
 * @param all 全部标签（顺序保持原样）
 * @param width 标签栏可用宽度（px）
 * @param activeId 当前选中的标签
 * @param primaryIds 常驻的标签 id（默认 `PRIMARY_TABS`）
 */
export function shelfTabs<T extends { id: string }>(
  all: readonly T[],
  width: number,
  activeId: string,
  primaryIds: readonly string[] = PRIMARY_TABS,
): TabShelf<T> {
  /* 宽度未知（首帧还没量到）→ 按窄处理：宁可收进菜单，也不要挤爆一行 */
  const wide = Number.isFinite(width) && width >= WIDE_THRESHOLD
  if (wide) return { inline: [...all], overflow: [] }

  const inline: T[] = []
  const overflow: T[] = []
  for (const tab of all) {
    if (primaryIds.includes(tab.id) || tab.id === activeId) inline.push(tab)
    else overflow.push(tab)
  }
  return { inline, overflow }
}

/* ══════════════════════════════════════════════════════════════
   P3 #9：一个入口此刻该亮什么
   ══════════════════════════════════════════════════════════════ */

/**
 * 三类互斥，优先级：waiting > running > content。
 *
 * ★ 为什么 waiting 最高：它代表**在等你**（未读严重错误），
 *   比「里面在跑」更需要被看见。
 */
export type TabActivity = 'none' | 'running' | 'waiting' | 'content'

export interface TabSignals {
  /** 任务面板：真有任务在跑（不是「有未完成任务」—— 那个只是有内容） */
  taskRunning: boolean
  /** 下载面板：真有正在传输的 */
  downloadRunning: boolean
  /** 浏览器面板：Agent 动过网页且用户还没看 */
  agentUsedBrowser: boolean
  /** 错误面板：未读的严重错误条数 */
  errorUnread: number
  /** 错误面板：最严重一级（决定点的颜色） */
  errorWorst: 'P0' | 'P1' | null
  /** 只是一般「有内容」的几类 */
  taskPending: boolean
  downloadsActive: boolean
  artifactPresent: boolean
}

/**
 * 这个入口该亮什么。
 *
 * ★ 「静态查看面板不因被打开而发光」这条在这里落地：本函数只看
 *   **事件侧的事实**（有没有在跑、有没有未读），完全不知道「当前选中谁」——
 *   所以打开一个面板不可能让它自己变成 running。
 * ★ 「历史错误不被当作新运行中的任务」也在这里：错误只可能出 `waiting`，
 *   永远不会出 `running`。
 */
export function activityOf(tab: string, signals: TabSignals): TabActivity {
  if (tab === 'errors') return signals.errorUnread > 0 ? 'waiting' : 'none'
  if (tab === 'tasks') {
    if (signals.taskRunning) return 'running'
    return signals.taskPending ? 'content' : 'none'
  }
  if (tab === 'downloads') {
    if (signals.downloadRunning) return 'running'
    return signals.downloadsActive ? 'content' : 'none'
  }
  if (tab === 'browser') {
    /* Agent 动过网页 = 「你没看的时候它动了手」，属于**已完成待看**，不是运行中 */
    return signals.agentUsedBrowser ? 'content' : 'none'
  }
  if (tab === 'artifacts') return signals.artifactPresent ? 'content' : 'none'
  return 'none'
}
