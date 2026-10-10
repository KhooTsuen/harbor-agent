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
   ══════════════════════════════════════════════════════════════ */

export const TABS: readonly { id: RightTab; label: string; icon: typeof FileCode2 }[] = [
  { id: 'diff', label: '审查', icon: GitCompareArrows },
  { id: 'files', label: '文件', icon: FileCode2 },
  { id: 'browser', label: '浏览器', icon: Globe },
  { id: 'artifacts', label: '成果', icon: Package },
  { id: 'tasks', label: '任务', icon: ListTodo },
  { id: 'downloads', label: '下载', icon: Download },
  { id: 'state', label: '状态', icon: Activity },
  /* 内核记的错误（只读）—— 排查「刚才那个按钮为什么没反应」时的第一站 */
  { id: 'errors', label: '错误', icon: ShieldAlert },
] as const

interface RightTabsProps {
  activeRightTab: RightTab
  /** 「审查」标签后面的改动文件数（0 就不显示） */
  diffCount: number
  /** Agent 动过网页、而用户还没点开看过（收尾第一步的角标） */
  agentUsedBrowser: boolean
  onSelect: (tab: RightTab) => void
  onClose: () => void
}

export function RightTabs({
  activeRightTab,
  diffCount,
  agentUsedBrowser,
  onSelect,
  onClose,
}: RightTabsProps) {
  return (
    /*
      标签栏：右栏默认只有 380px，七个标签都带文字会被挤成竖排单字。
      改法：**只有当前标签显示文字**，其余只留图标（悬停有 tooltip），
      这样在最小宽度和最大字号缩放下都放得下；再窄就横向滚动（滚动条隐藏），
      关闭按钮留在滚动区外面，永远可见。
    */
    <div className="flex shrink-0 items-center gap-0.5 border-b border-line-subtle px-1.5 py-1">
      {TABS.map((tab) => {
        const Icon = tab.icon
        const active = tab.id === activeRightTab
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            aria-current={active}
            title={tab.label}
            aria-label={tab.label}
            className={cn(
              'relative flex h-7 shrink-0 items-center justify-center gap-1 rounded-sm transition-colors duration-fast',
              active
                ? 'min-w-12 bg-bg-raised px-2 text-fg-primary'
                : 'w-7 px-0 text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
            )}
          >
            <Icon size={13} className="shrink-0" />
            {/* 非当前标签靠 aria-label + title 说明，视觉上只留图标，避免七等分挤字。 */}
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
          </button>
        )
      })}
      <IconButton label="关闭右侧面板" size={28} className="ml-auto shrink-0" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
