import { Fragment } from 'react'
import {
  Activity,
  Download,
  FileCode2,
  GitCompareArrows,
  Globe,
  ListTodo,
  Package,
  ShieldAlert,
  X,
} from 'lucide-react'
import type { RightTab } from '@/types'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'
import { ContentDot, UnreadDot } from './TabBadge'

/* ══════════════════════════════════════════════════════════════
   右栏的标签栏（从 RightPanel 里搬出来的）

   搬出来的原因很实在：加上「Agent 动过网页」的角标之后，RightPanel.tsx
   到了 321 行，破了硬约束 #2（单文件 ≤ 300 行）的线。

   缝在哪儿 —— 这里是最自然的一条：**标签栏只关心「有几个标签、当前是哪个、
   各自要显示什么角标」，不关心下面是文件树还是 diff。** 它原来嵌在
   RightPanel 的 props 和 store 订阅中间，谁改谁都得读完整 300 行。

   已注意拆分的两个老坑：
     · 只搬了标签栏这一段（`TABS` + 那个 `<div>` 标签组），没连坐旁边的内容区；
     · 没有留空占位 —— RightPanel 里原来那段是**删掉**的，不是换成 `{}`。

   ── Phase 2 · C：按频率分组 ──────────────────────────────────
   八个标签此前**同层同权重**，找一个高频入口（审查 / 文件 / 任务）和找一个
   低频入口（状态）花的力气一样。现在按「用的频率」分成两组，中间一条发丝
   分隔线，**八个标签一个不少、全都能点**（不做二级菜单，不隐藏任何入口）：

     group 1（高频）：审查 · 文件 · 任务 · 成果
     group 2（低频）：浏览器 · 下载 · 状态 · 错误

   代价只有一个：位置变了一次，肌肉记忆要重新对一遍。见
   `docs/research/phase2-improvement-plan.md` §3 的路径盘点。
   ══════════════════════════════════════════════════════════════ */

/**
 * `group` 只决定「排在哪、要不要在它前面画一条分隔线」，不改变可点性 ——
 * 八个标签永远都在标签栏里。
 */
export const TABS: readonly {
  id: RightTab
  label: string
  icon: typeof FileCode2
  group: 1 | 2
}[] = [
  /* 高频：看改动 / 看文件 / 看待办 / 看产出 */
  { id: 'diff', label: '审查', icon: GitCompareArrows, group: 1 },
  { id: 'files', label: '文件', icon: FileCode2, group: 1 },
  { id: 'tasks', label: '任务', icon: ListTodo, group: 1 },
  { id: 'artifacts', label: '成果', icon: Package, group: 1 },
  /* 低频：用完就走 */
  { id: 'browser', label: '浏览器', icon: Globe, group: 2 },
  { id: 'downloads', label: '下载', icon: Download, group: 2 },
  { id: 'state', label: '状态', icon: Activity, group: 2 },
  /* 内核记的错误（只读）—— 排查「刚才那个按钮为什么没反应」时的第一站 */
  { id: 'errors', label: '错误', icon: ShieldAlert, group: 2 },
] as const

interface RightTabsProps {
  activeRightTab: RightTab
  /** 「审查」标签后面的改动文件数（0 就不显示） */
  diffCount: number
  /** Agent 动过网页、而用户还没点开看过（收尾第一步的角标） */
  agentUsedBrowser: boolean
  /** Phase 1 · A1：未读的严重（P0/P1）错误条数（0 就不显示） */
  errorUnread: number
  /** 未读里最严重的一级 —— 角标颜色据此选（仍走 statusLanguage） */
  errorWorst: 'P0' | 'P1' | null
  /** Phase 2 · C：有未完成 / 在跑的任务（「有内容」，不是错误） */
  taskPending: boolean
  /** Phase 2 · C：下载列表里有条目（「有内容」，不是错误） */
  downloadsActive: boolean
  /** Phase 2 · C：当前会话确有正式产物（「有内容」，不是错误） */
  artifactPresent: boolean
  onSelect: (tab: RightTab) => void
  onClose: () => void
}

export function RightTabs({
  activeRightTab,
  diffCount,
  agentUsedBrowser,
  errorUnread,
  errorWorst,
  taskPending,
  downloadsActive,
  artifactPresent,
  onSelect,
  onClose,
}: RightTabsProps) {
  /*
   * 「有内容」提示只挂在这三类上（与「未读错误」严格分开，见 TabBadge）：
   * 「有内容」= 里面有点东西；「未读严重错误」= 有需要你处理的问题。
   */
  const hasContent: Partial<Record<RightTab, boolean>> = {
    tasks: taskPending,
    downloads: downloadsActive,
    artifacts: artifactPresent,
  }

  return (
    /*
      标签栏：右栏默认只有 380px，多个标签都带文字会被挤成竖排单字。
      改法：**只有当前标签显示文字**，其余只留图标（悬停有 tooltip），
      这样在最小宽度和最大字号缩放下都放得下；再窄就横向滚动（滚动条隐藏），
      关闭按钮留在滚动区外面，永远可见。
    */
    <div className="flex shrink-0 items-center gap-0.5 border-b border-line-subtle px-1.5 py-1">
      {TABS.map((tab, index) => {
        const Icon = tab.icon
        const active = tab.id === activeRightTab
        /* Phase 1 · A1：错误标签的「未读」提示 —— 数字进 title/aria-label，视觉上是个点 */
        const unread = tab.id === 'errors' ? errorUnread : 0
        const label = unread > 0 ? `${tab.label}（${unread} 条未读的严重错误）` : tab.label
        /* 两条相邻标签分属不同组时，在它们之间画一条发丝线（纯装饰，不可点） */
        const divider = index > 0 && tab.group === 2 && TABS[index - 1].group === 1
        return (
          <Fragment key={tab.id}>
            {divider ? (
              <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-line-subtle" />
            ) : null}
            <button
              type="button"
              onClick={() => onSelect(tab.id)}
              aria-current={active}
              title={label}
              aria-label={label}
              className={cn(
                'relative flex h-7 shrink-0 items-center justify-center gap-1 rounded-sm transition-colors duration-fast',
                active
                  ? 'min-w-12 bg-bg-raised px-2 text-fg-primary'
                  : 'w-7 px-0 text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
              )}
            >
              <Icon size={13} className="shrink-0" />
              {/* 非当前标签靠 aria-label + title 说明，视觉上只留图标，避免挤字。 */}
              <span className={cn('text-2xs', !active && 'sr-only')}>{tab.label}</span>
              {tab.id === 'diff' && diffCount > 0 ? (
                <span className="shrink-0 font-mono text-2xs text-fg-tertiary">{diffCount}</span>
              ) : null}
              {/*
                Agent 动过网页的角标：只在**没在看这个标签**时点出来
                （正在看就是不打扰），说清楚「你没看的时候它动了手」。
                静态的点，不闪 —— 长时间运行时闪烁提示只会变成噪音。
              */}
              {tab.id === 'browser' && agentUsedBrowser && !active ? (
                <span
                  className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-accent"
                  aria-hidden
                />
              ) : null}
              {/*
                Phase 2 · C：三类「有内容」提示 —— **空心环 + 中性色**，
                与下面那个实心红/橙点（未读错误）在形状和颜色上都不同（见 TabBadge）。
                静态，不闪；也不因「正在看」而隐藏（它就是「里面有东西」这个事实本身）。
              */}
              {!unread && hasContent[tab.id] ? <ContentDot /> : null}
              {/*
                Phase 1 · A1：未读严重错误的角标。和浏览器那个不同，**不因「正在看」而隐藏** ——
                因为「已读」由打开标签时 acknowledge() 处理（打开那一刻就清零），
                所以正在看时若它还在，说明是你在看的时候新冒出来的，更该点出来。
                颜色按最严重一级取（P0 失败色 / P1 警告色），仍来自 statusLanguage。
              */}
              {unread > 0 ? <UnreadDot worst={errorWorst} /> : null}
            </button>
          </Fragment>
        )
      })}
      <IconButton label="关闭右侧面板" size={28} className="ml-auto shrink-0" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
