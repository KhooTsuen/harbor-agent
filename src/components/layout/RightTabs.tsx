import { Fragment, useState } from 'react'
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
import { Popover } from '@/components/ui/Popover'
import { ContentDot, UnreadDot } from './TabBadge'
import { activityOf, shelfTabs, type TabSignals } from './tabShelf'
import { useElementWidth } from '@/hooks/useElementWidth'

/* ══════════════════════════════════════════════════════════════
   右栏的标签栏（从 RightPanel 里搬出来的）

   ── P3 #18：常用入口必须显示名称 ──────────────────────────────
   以前这里「只有当前标签显示文字，其余全是 28px 纯图标」。挤不下是事实，
   但纯图标堆叠正是文档点名不要的形态 —— 普通用户认不出哪个是「成果」。
   现在按**右栏自己的宽度**分两档（规则与门槛在 `tabShelf.ts`，纯函数可单测）：
     · 宽 → 八个标签全部带文字
     · 窄 → 三个高频主入口（审查 / 文件 / 任务）带文字，
            其余五个收进一个**带名字的「更多」菜单**（不是缩成图标）
   当前标签若落在菜单里，栏上仍露出它的名字，否则看不出「我在哪个面板」。

   ── P3 #9：进行中提示是渐变呼吸，且只给真有活动的入口 ────────
   规则每一条都对应文档里的一句话（判据在 `tabShelf.ts` 的 `activityOf`）：
     · running —— 这个面板对应的东西**正在跑** → 轻微呼吸光晕
     · waiting —— 在等你操作（未读严重错误）→ 实心点，不闪
     · content —— 只是「里面有东西」→ 空心环，不闪
   静态面板**不因为被打开就发光**（`activityOf` 根本不知道当前选中谁）；
   减少动效模式下呼吸降级为静态描边，含义同时写在 title / aria-label 里。
   ══════════════════════════════════════════════════════════════ */

/**
 * `group` 只决定「排在哪、要不要在它前面画一条分隔线」，不改变可点性。
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

/** 窄栏情况下，「正在跑」的呼吸光晕（减少动效时降级为静态描边） */
const RUNNING_CLASS =
  'animate-[tabBreath_2.4s_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:ring-1 motion-reduce:ring-[var(--accent-blue)]'

interface RightTabsProps {
  activeRightTab: RightTab
  /** 「审查」标签后面的改动文件数（0 就不显示） */
  diffCount: number
  /** Agent 动过网页、而用户还没点开看过 */
  agentUsedBrowser: boolean
  /** 未读的严重（P0/P1）错误条数（0 就不显示） */
  errorUnread: number
  /** 未读里最严重的一级 —— 角标颜色据此选（仍走 statusLanguage） */
  errorWorst: 'P0' | 'P1' | null
  /** 有未完成 / 在跑的任务 */
  taskPending: boolean
  /** 下载列表里有条目 */
  downloadsActive: boolean
  /** 当前会话确有正式产物 */
  artifactPresent: boolean
  /** P3 #9：真有任务在跑（决定「任务」标签呼吸） */
  taskRunning: boolean
  /** P3 #9：真有下载在传（决定「下载」标签呼吸） */
  downloadRunning: boolean
  onSelect: (tab: RightTab) => void
  onClose: () => void
}

export function RightTabs(props: RightTabsProps) {
  const { activeRightTab, onSelect, onClose } = props
  /* 量**右栏自己**的宽度（不是窗口）—— 标签栏挤不挤只取决于它 */
  const { ref, width } = useElementWidth<HTMLDivElement>()
  const { inline, overflow } = shelfTabs(TABS, width, activeRightTab)
  const signals: TabSignals = {
    taskRunning: props.taskRunning,
    downloadRunning: props.downloadRunning,
    agentUsedBrowser: props.agentUsedBrowser,
    errorUnread: props.errorUnread,
    errorWorst: props.errorWorst,
    taskPending: props.taskPending,
    downloadsActive: props.downloadsActive,
    artifactPresent: props.artifactPresent,
  }
  const activeInMenu = overflow.find((tab) => tab.id === activeRightTab)

  return (
    <div
      ref={ref}
      className="flex shrink-0 items-center gap-0.5 border-b border-line-subtle px-1.5 py-1"
    >
      {/*
        标签区。这两条类是**安全阀**（2026-10-20 补）：
          · `min-w-0` —— flex 子项默认 `min-width: auto`（= 内容最小宽），
            不加它，内容一多就会把这一格撑破；
          · `overflow-hidden` —— 万一仍然放不下，裁在这里，而不是让整条栏
            横向溢出 / 冒出横向滚动条（滚动条还会把栏挤高）。
        ★ 关闭按钮在**这个容器之外**，所以任何宽度、任何一帧都停在最右边、
          点得到 —— 以前它在滚动容器里，内容一超就被推出可视区，
          正是「标签挤满一行、找不到关闭按钮」的成因。
      */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        {inline.map((tab, index) => {
          const Icon = tab.icon
          const active = tab.id === activeRightTab
          const activity = activityOf(tab.id, signals)
          /* 状态词进 title / aria-label —— 不只靠颜色传达含义 */
          const label =
            tab.id === 'errors' && props.errorUnread > 0
              ? `${tab.label}（${props.errorUnread} 条未读的严重错误）`
              : activity === 'running'
                ? `${tab.label}（进行中）`
                : tab.label
          return (
            <Fragment key={tab.id}>
              {index > 0 && tab.group === 2 && inline[index - 1].group === 1 ? (
                <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-line-subtle" />
              ) : null}
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                aria-current={active}
                title={label}
                aria-label={label}
                className={cn(
                  'relative flex h-7 min-w-0 shrink items-center justify-center gap-1 rounded-sm transition-colors duration-fast',
                  active
                    ? 'bg-bg-raised px-2 text-fg-primary'
                    : 'px-1.5 text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                  /* 进行中的呼吸光晕；不挂在「正开着的静态面板」上 */
                  activity === 'running' && !active && RUNNING_CLASS,
                )}
              >
                <Icon size={13} className="shrink-0" />
                {/* 文字常驻（不再是 sr-only）—— 这就是 #18 要的「显示名称」。
                  极端窄时截成省略号，但按钮本身不消失（入口比全文重要） */}
                <span className="truncate text-2xs">{tab.label}</span>
                {tab.id === 'diff' && props.diffCount > 0 ? (
                  <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
                    {props.diffCount}
                  </span>
                ) : null}
                {activity === 'content' ? <ContentDot /> : null}
                {activity === 'waiting' ? <UnreadDot worst={props.errorWorst} /> : null}
              </button>
            </Fragment>
          )
        })}

        {overflow.length > 0 ? (
          <MoreMenu
            tabs={overflow}
            activeRightTab={activeRightTab}
            activeName={activeInMenu?.label ?? ''}
            signals={signals}
            onSelect={onSelect}
          />
        ) : null}
      </div>

      <IconButton label="关闭右侧面板" size={28} className="shrink-0" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </div>
  )
}

/** 窄栏时的「更多」菜单：每一项都是图标 + 文字，一个入口都不少 */
function MoreMenu({
  tabs,
  activeRightTab,
  activeName,
  signals,
  onSelect,
}: {
  tabs: readonly (typeof TABS)[number][]
  activeRightTab: RightTab
  activeName: string
  signals: TabSignals
  onSelect: (tab: RightTab) => void
}) {
  /* Popover 是受控的 —— 本地一个 open 就够，不需要进任何 store */
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label="更多面板"
          title="更多面板"
          className={cn(
            'flex h-7 shrink-0 items-center gap-1 rounded-sm px-1.5 text-2xs transition-colors duration-fast',
            activeName ? 'bg-bg-raised text-fg-primary' : 'text-fg-secondary hover:bg-bg-hover',
          )}
        >
          {/* 收起时若当前面板在菜单里，就把它的名字露出来 */}
          {activeName || '更多'}
        </button>
      )}
    >
      <ul className="flex min-w-32 flex-col p-1" aria-label="更多面板">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const activity = activityOf(tab.id, signals)
          return (
            <li key={tab.id}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onSelect(tab.id)
                  setOpen(false)
                }}
                aria-current={tab.id === activeRightTab}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors duration-fast',
                  tab.id === activeRightTab
                    ? 'bg-bg-raised text-fg-primary'
                    : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                )}
              >
                <Icon size={13} className="shrink-0" />
                <span className="flex-1">{tab.label}</span>
                {activity === 'running' ? (
                  <span className="text-2xs text-fg-tertiary">进行中</span>
                ) : null}
                {activity === 'waiting' ? <UnreadDot worst={signals.errorWorst} /> : null}
                {activity === 'content' ? <ContentDot /> : null}
              </button>
            </li>
          )
        })}
      </ul>
    </Popover>
  )
}
