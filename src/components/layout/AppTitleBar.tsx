import { useRef } from 'react'
import { Loader2, PanelBottom, PanelLeft, PanelRight } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useEggStore } from '@/stores/useEggStore'
import { BRAND_NAME } from '@/constants'
import { createBrandClickState, registerBrandClick } from '@/lib/nightVoyage'
import { useUIStore } from '@/stores/useUIStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { useRightTabBadges } from '@/hooks/useRightTabBadges'
import { colorOf } from '@/lib/statusLanguage'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { sumDiff } from '@/components/chat/DiffViewer'
import { useAgentActive } from '@/hooks/useAgentActive'
import { activityLabel } from '@/lib/agentActivity'

/* ══════════════════════════════════════════════════════════════
   窗口级顶栏（高 40px，**横跨整个窗口**）

   它不属于任何一栏，而是压在左中右三栏之上的一条 —— 这是它和普通顶栏
   唯一的、也是全部的区别。之所以要这样：窗口用了 titleBarStyle:'hidden'，
   系统标题栏的背景被隐藏、界面自己顶到窗口最上沿，原生按钮（最小化 /
   最大化 / 关闭）浮在右上角。这种时候如果顶栏还是「每栏各一条」，顶部
   看起来就是「三块面板顶栏 + 一层系统边框」，而不是一个整体。

   三件事必须同时成立，缺一个就坏：

     ① 整条能拖动窗口（titlebar-drag），但里面的控件要 no-drag —— 见 index.css，
        那边用后代选择器统一排除，免得以后每加一个控件都要记得补
     ② 右侧必须给原生按钮让位（--titlebar-right），否则会被盖上
     ③ **不做卡片、不加圆角**，背景直接用 --bg-canvas、只留底部一条发丝线。
        它是一条「边」，不是一块「板」

   ── 2026-10-31 第二阶段：布局与语义 ──────────────────────────
   **左**：侧栏开关 + 品牌标 + 当前对话标题（位置类的东西）
   **中**：这条对话正在干什么 + 它的改动行数（会变的东西）
   **右**：底部面板开关 / 后台任务 / 右栏开关 + 让位给窗口按钮

   ★ 移除「继续 / 停止」：那个「继续」做的只是 `sendMessage('继续')` ——
     发出去一条内容是「继续」的消息，**不是**恢复暂停的任务。同一个动作在
     对话框里已经有了（Composer 的发送 / 停止），顶栏再放一份既重复又误导。
     恢复暂停任务在右栏「任务」里（那里才是真的 resume）。

   ★ 「+N −M」和右栏「审查」是**同一批数**（都读 `useTaskStore.diff`），
     文案也统一说「改动」而不是「未提交改动」—— 它跟 git 的 index 没关系。
   ══════════════════════════════════════════════════════════════ */

export function AppTitleBar({ onToggleBottomPanel }: { onToggleBottomPanel: () => void }) {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const sidebarCollapsed = useSettingsStore((s) => s.settings.sidebarCollapsed)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const rightPanelVisible = useUIStore((s) => s.rightPanelVisible)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const setRightPanelVisible = useUIStore((s) => s.setRightPanelVisible)

  /*
   * Phase 1 · A2 / Phase 2 · C：右栏折叠或窄窗口时，标签栏可能被裁掉甚至整个收起，
   * 所以把「需要留意的工作状态」挂到这个**始终可见**的顶栏按钮上：
   *   · 未读的严重错误（Phase 1）
   *   · 正在运行的后台任务数（Phase 2）
   * 数据与右栏角标**同源**（useRightTabBadges），不是第二份。
   */
  const badges = useRightTabBadges()
  const { errorUnread, errorWorst, runningTasks } = badges

  /* 当前这条对话在不在跑（别的对话跑着是别的事） */
  const sending = useAgentActive(thread?.id)

  /*
    AG-008：顶栏顺带说一句「现在到底在干什么」。
    toolRuns 挂在 assistant 消息上，所以要找**最后一条助手消息**，
    不能直接拿 messages.at(-1) —— 那可能是用户刚发出去的那条。

    ★ 只在 `sending` 为真时显示：这条是**当前请求**的活动，
      不是上一轮留下的记录（第二阶段明确要求）。
  */
  const lastAssistant = [...(thread?.messages ?? [])].reverse().find((m) => m.role === 'assistant')
  const activity = activityLabel(lastAssistant?.toolRuns ?? [], thread?.phase)

  /*
   * 夜航彩蛋（设计文档 §13.3）：连点品牌标 5 次（2 秒窗口）→
   * 夜航主题 ↔ 默认来回切。计时规则在 lib/nightVoyage.ts（纯函数），
   * 这里只管副作用：改设置 + 灯塔扫一次 + toast。
   */
  const brandClicks = useRef(createBrandClickState())
  const onBrandClick = (): void => {
    const { state, fired } = registerBrandClick(brandClicks.current, Date.now())
    brandClicks.current = state
    if (!fired) return
    const settings = useSettingsStore.getState()
    const goingNight = settings.settings.theme !== 'night'
    settings.updateSettings({ nightUnlocked: true, theme: goingNight ? 'night' : 'default' })
    useEggStore.getState().bumpSweep()
    useUIStore
      .getState()
      .showToast(
        'info',
        goingNight ? '夜航模式已启用' : '夜航模式已关闭',
        goingNight ? '灯塔已点亮。再连点 5 次可以换回来。' : '已回到默认主题',
      )
  }

  /* AG-036：和右栏「审查」读同一份（改动事务里算出来的），不再各算一套 */
  const diffs = useTaskStore((s) => s.diff)?.files ?? []
  const { additions, deletions } = sumDiff(diffs)

  /*
   * Phase 2 · C：右栏折叠 / 窄窗时，把「需要留意的工作状态」并进右栏按钮的
   * 悬停提示 —— 这样不占地方，却不会「折叠了就什么都不知道」。
   * 文案与右栏一致：说的是**改动**（Harbor 记下的一批），不是 git 未提交。
   */
  const rightPanelNotes: string[] = []
  if (errorUnread > 0) rightPanelNotes.push(`${errorUnread} 条未读的严重错误`)
  if (runningTasks > 0) rightPanelNotes.push(`${runningTasks} 个后台任务在运行`)
  if (diffs.length > 0) rightPanelNotes.push(`当前对话最近一批改动涉及 ${diffs.length} 个文件`)
  const rightPanelLabel =
    rightPanelNotes.length > 0 ? `切换右侧面板（${rightPanelNotes.join(' · ')}）` : '切换右侧面板'

  return (
    <header
      className="titlebar-drag glass-panel flex shrink-0 items-center gap-1.5 border-b border-line-subtle px-3"
      style={{ height: 40, paddingRight: 'calc(var(--titlebar-right) + 16px)' }}
    >
      {/* ── 左：位置 ── */}
      <Tooltip content={sidebarCollapsed ? '展开侧边栏（Ctrl+B）' : '折叠侧边栏（Ctrl+B）'}>
        <IconButton
          label="切换侧边栏"
          size={28}
          onClick={() => updateSettings({ sidebarCollapsed: !sidebarCollapsed })}
        >
          <PanelLeft size={15} />
        </IconButton>
      </Tooltip>

      {/* 品牌标：也是夜航彩蛋的点击位（按钮 = titlebar 里自动 no-drag，见 index.css） */}
      <button
        type="button"
        onClick={onBrandClick}
        aria-label={BRAND_NAME}
        className="flex shrink-0 items-center gap-1.5 rounded-small"
      >
        <span
          aria-hidden="true"
          className="grid size-5 place-items-center rounded-small bg-bg-raised font-mono text-2xs font-semibold text-fg-primary"
        >
          ⌘
        </span>
        <span className="hidden text-dense font-semibold text-fg-primary sm:inline">
          {BRAND_NAME}
        </span>
      </button>

      {/* 当前对话标题。它是状态不是标题，所以用次级色、不上大字号 */}
      <h1 className="min-w-0 max-w-[30%] truncate px-2 text-dense text-fg-secondary">
        {thread?.title ?? '没有打开的对话'}
      </h1>

      {/* ── 中：这条对话的活动与改动（只在真有时出现，不做恒定装饰） ── */}
      <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-2xs text-fg-tertiary">
        {sending ? (
          <span className="flex min-w-0 max-w-[34vw] items-center gap-1.5 truncate">
            <Loader2 size={11} className="shrink-0 animate-spin" />
            <span className="truncate">{activity}</span>
          </span>
        ) : null}

        {/*
          改动行数点一下直接去「审查」—— 两处说的是同一批文件，
          让「点一下就看见是什么」比单纯显示一个数字有用。
        */}
        {diffs.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setActiveRightTab('diff')
              setRightPanelVisible(true)
            }}
            className="flex shrink-0 items-center gap-2 rounded-sm px-1 font-mono hover:bg-bg-hover"
            title={`当前对话最近一批改动：${diffs.length} 个文件，${additions} 行新增，${deletions} 行删除`}
            aria-label={`查看当前对话最近一批改动（${diffs.length} 个文件）`}
          >
            <span style={{ color: 'var(--diff-add)' }}>+{additions}</span>
            <span style={{ color: 'var(--diff-remove)' }}>−{deletions}</span>
            <span className="text-fg-tertiary">{diffs.length} 个文件</span>
          </button>
        ) : null}
      </div>

      {/* ── 右：面板开关 + 窗口按钮让位 ── */}
      <div className="flex shrink-0 items-center gap-0.5">
        {/*
          右边这几个**故意不挂提示**：`hint=""` 就是「不要提示」（提示实现里空文案
          直接不渲染）。它们紧贴原生窗口按钮，提示往下弹会正好落在右栏那排标签
          （审查 / 终端 / 文件…）上，两块字叠在一起，比没提示难看得多。
          图标本身够清楚，无障碍靠 aria-label（IconButton 的 label），不受影响。
        */}
        <IconButton label="切换底部面板" hint="" size={28} onClick={onToggleBottomPanel}>
          <PanelBottom size={15} />
        </IconButton>

        {/*
          后台任务数是**跨对话**的（任务中心是全局的），所以它必须说清楚
          「有 N 个任务在跑」，而不是混进上面那条「当前请求」里。
          点它去「任务」标签 —— 恢复暂停任务在那儿。
        */}
        {runningTasks > 0 ? (
          <button
            type="button"
            onClick={() => {
              setActiveRightTab('tasks')
              setRightPanelVisible(true)
            }}
            className="flex h-7 shrink-0 items-center gap-1 rounded-sm px-1.5 text-2xs text-fg-tertiary hover:bg-bg-hover"
            title={`后台有 ${runningTasks} 个任务在运行（可能是别的对话的）—— 点开任务中心`}
            aria-label={`后台有 ${runningTasks} 个任务在运行，打开任务中心`}
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: colorOf('running') }}
              aria-hidden
            />
            <span className="font-mono">{runningTasks}</span>
          </button>
        ) : null}

        <IconButton
          label={rightPanelLabel}
          hint=""
          size={28}
          active={rightPanelVisible}
          onClick={toggleRightPanel}
        >
          <span className="relative grid place-items-center">
            <PanelRight size={15} />
            {/* 与「错误」标签同一个点：P0 失败色 / P1 警告色（statusLanguage 唯一来源） */}
            {errorUnread > 0 ? (
              <span
                className="absolute -right-1 -top-1 size-1.5 rounded-full"
                style={{ background: colorOf(errorWorst === 'P0' ? 'failed' : 'warning') }}
                aria-hidden
              />
            ) : null}
          </span>
        </IconButton>
      </div>
    </header>
  )
}
