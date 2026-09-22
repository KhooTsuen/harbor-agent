import { useEffect, useState } from 'react'
import { Activity, FileCode2, GitCompareArrows, Globe, ListTodo, Package, X } from 'lucide-react'
import type { FileNode, Project, RightTab } from '@/types'
import { cn } from '@/lib/utils'
import { colorOf } from '@/lib/statusLanguage'
import { useAgentActive } from '@/hooks/useAgentActive'
import { buildFileTree } from '@/lib/mock'
import { fsTree, toFileNode } from '@/lib/fsApi'
import { sumDiff } from '@/components/chat/DiffViewer'
import { DiffViewer } from '@/components/chat/DiffViewer'
import { FileTree } from './FileTree'
import { FilePreview } from './FilePreview'
import { BrowserTab } from './BrowserTab'
import { useBrowseBridge } from './browser/useBrowseBridge'
import { ArtifactsPanel } from '@/components/chat/ArtifactsPanel'
import { StatePanel } from '@/components/chat/StatePanel'
import { TaskCenter } from '@/components/chat/TaskCenter'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { isElectron } from '@/lib/backend'

/* ══════════════════════════════════════════════════════════════
   RightPanel

   右侧工作区：审查 / 终端 / 文件 / 浏览器 / 成果 / 任务 / 状态。
   「任务」是 AG-028 的全局后台任务中心；「状态」仍是当前对话的长期状态。
   ══════════════════════════════════════════════════════════════ */

const TABS: readonly { id: RightTab; label: string; icon: typeof FileCode2 }[] = [
  { id: 'diff', label: '审查', icon: GitCompareArrows },
  { id: 'files', label: '文件', icon: FileCode2 },
  { id: 'browser', label: '浏览器', icon: Globe },
  { id: 'artifacts', label: '成果', icon: Package },
  { id: 'tasks', label: '任务', icon: ListTodo },
  { id: 'state', label: '状态', icon: Activity },
] as const

/* ── 主组件 ─────────────────────────────────────────────────── */

const EMPTY_PROJECT: Project = {
  id: '',
  name: '本地',
  description: '',
  path: '',
  branch: '',
  icon: '',
  color: '',
  pinned: false,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
}

export function RightPanel() {
  /* 接住 Agent 的浏览请求（挂在这里而不是 BrowserTab：请求来时标签可能没开）*/
  useBrowseBridge()

  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const active = useAgentActive(thread?.id)

  /*
   * 右栏（文件树 / 终端）该看哪个目录：**跟着当前这条对话走**。
   * 单独对话没挂目录 → 用全局默认。
   *
   * 子组件（FileTree）收的是 Project，所以这里合成一个 ——
   * 为这点事改三四个组件的 props 不划算。
   */
  /*
   * ★ 这个 selector 会**合成一个新对象**（没挂目录时要现造一条）。zustand 默认用
   *   `Object.is` 比结果 —— 于是每次 store 有任何变动都算「变了」，组件重渲染、
   *   下面那个 `useEffect` 跟着又跑一遍 `fs:tree`…
   *   真机上日志流水里就是这么现形的：`fs:tree` 同一秒成对出现、每次 60~700ms。
   *   包一层 useShallow：只有那几个字段真的变了才算变。
   */
  const effectiveProject = useAppStore(
    useShallow((s) => {
      const active = s.threads.find((t) => t.id === s.activeThreadId)
      if (!active) return null
      const dir = active.workdir || s.workdir || ''
      if (!dir) return null
      /* 已经在 projects 里的目录直接用那一条（名字之类都是现成的） */
      const known = s.projects.find((p) => p.path === dir)
      if (known) return known
      const name = dir.replace(/[\/]+/g, '/').split('/').filter(Boolean).pop() || dir
      return { ...(s.projects[0] ?? EMPTY_PROJECT), id: `dir:${dir}`, path: dir, name }
    }),
  )

  const activeRightTab = useUIStore((s) => s.activeRightTab)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const setRightPanelVisible = useUIStore((s) => s.setRightPanelVisible)

  const [openFile, setOpenFile] = useState<FileNode | null>(null)
  const [realTree, setRealTree] = useState<FileNode | null>(null)
  const [treeError, setTreeError] = useState('')

  /*
   * AG-036：这里的 diff 来自**改动事务的快照**（store 的 refresh 里拉的），
   * 不再从消息里翻 `message.diffs` —— 那条路真实流程里从来没人写过，
   * 于是这个标签一直显示「没有待审查的改动」，而 Agent 明明刚改过文件。
   */
  const changed = useTaskStore((s) => s.diff)
  const diffs = changed?.files ?? []
  const { additions, deletions } = sumDiff(diffs)
  const skipped = changed?.skipped ?? []

  /* 桌面版读取真实工作目录；浏览器预览才使用静态文件树 */
  useEffect(() => {
    void (async () => {
      const tree = await fsTree(effectiveProject?.path)
      if (tree && tree.ok) {
        setTreeError('')
        setRealTree({
          id: tree.root,
          name: tree.name,
          type: 'folder',
          path: tree.root,
          children: tree.children.map(toFileNode),
        })
      } else {
        setRealTree(null)
        if (isElectron) setTreeError(tree?.error ?? '真实工作目录读取失败')
      }
    })()
    /* 依赖写 path（原始值）：这个 effect 只用到路径，拿整个对象当依赖等于"随它变" */
  }, [effectiveProject?.path])

  /* 桌面版失败时不能悄悄退回假文件树；浏览器预览才允许静态树。 */
  const fileTree =
    realTree ?? (!isElectron && effectiveProject ? buildFileTree(effectiveProject) : null)

  return (
    <aside
      className="flex h-full min-h-0 flex-col border-l border-line-subtle bg-bg-base"
      aria-label="右侧面板"
    >
      {/*
        标签栏：右栏默认只有 380px，七个标签都带文字会被挤成竖排单字。
        改法：**只有当前标签显示文字**，其余只留图标（悬停有 tooltip），
        这样在最小宽度和最大字号缩放下都放得下；再窄就横向滚动（滚动条隐藏），
        关闭按钮留在滚动区外面，永远可见。
      */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-line-subtle px-1.5 py-1">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = tab.id === activeRightTab
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveRightTab(tab.id)}
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
              {tab.id === 'diff' && diffs.length > 0 ? (
                <span className="shrink-0 font-mono text-2xs text-fg-tertiary">{diffs.length}</span>
              ) : null}
            </button>
          )
        })}
        <IconButton
          label="关闭右侧面板"
          size={28}
          className="ml-auto shrink-0"
          onClick={() => setRightPanelVisible(false)}
        >
          <X size={14} />
        </IconButton>
      </div>

      {/* 内容 */}
      {/*
        内容区。
        多包一层 relative 是为了给下面的浏览器层当定位基准 —— 它要 absolute 铺满
        这一块（而不是铺满整个 aside），不然会盖住上面的标签栏。
      */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {activeRightTab === 'diff' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {diffs.length > 0 ? (
              <>
                <div className="flex shrink-0 items-center gap-3 border-b border-line-subtle px-3 py-2 text-2xs">
                  <span className="text-fg-secondary">未提交的改动</span>
                  {changed?.title ? (
                    <span className="min-w-0 truncate text-fg-tertiary" title={changed.title}>
                      {changed.title}
                    </span>
                  ) : null}
                  {active ? (
                    <span className="flex items-center gap-1 text-fg-tertiary">
                      <span className="inline-block size-1.5 animate-pulse rounded-full bg-warning" />
                      生成中…
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-2 font-mono">
                    <span style={{ color: 'var(--diff-add)' }}>+{additions}</span>
                    <span style={{ color: 'var(--diff-remove)' }}>−{deletions}</span>
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {skipped.length > 0 ? (
                    <p className="mb-2 text-2xs" style={{ color: colorOf('warning') }}>
                      ⚠ {skipped.join('；')}
                    </p>
                  ) : null}
                  <DiffViewer files={diffs} />
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState
                  icon={<GitCompareArrows size={28} />}
                  title="没有待审查的改动"
                  description="让 Agent 改点东西，diff 会出现在这里。也可以用 /review 主动发起一次审查。"
                />
              </div>
            )}
          </div>
        ) : null}

        {activeRightTab === 'files' ? (
          openFile ? (
            <FilePreview node={openFile} onClose={() => setOpenFile(null)} />
          ) : fileTree ? (
            <FileTree root={fileTree} activeFileId={null} onOpenFile={setOpenFile} />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={<FileCode2 size={28} />}
                title={treeError ? '读取工作目录失败' : '工作目录为空'}
                description={
                  treeError || '当前工作目录没有可显示的文件。去「设置 → 工具」检查工作目录。'
                }
              />
            </div>
          )
        ) : null}

        {activeRightTab === 'artifacts' ? <ArtifactsPanel /> : null}
        {activeRightTab === 'tasks' ? <TaskCenter /> : null}
        {activeRightTab === 'state' ? <StatePanel /> : null}

        {/*
          浏览器**不随标签卸载** —— 和终端同一个道理，但理由不一样：
          <webview> 一从 DOM 里摘掉，底下的 webContents 就被销毁，
          切回来等于重新打开网页 —— 滚动位置、填了一半的表单、SPA 的前端状态全没。
          （用户报的就是这个。）

          absolute 铺在内容区上，未激活时 invisible（不画、不接事件）。
          用 invisible 而不是 display:none 是取语义 ——「还在这儿，只是没在画」。
          手测过：两种写法下网页的 window.innerWidth 都是 369，不会塔成 0
          （Electron 不会把隐藏的 guest 缩到 0），所以这里不是靠它保尺寸，
          真正保尺寸的是 absolute inset-0。

          代价：浏览器开着就直一直占着一个渲染进程（这是「不丢状态」的必然开销）。
          没开过标签时只是个空状态，不费什么。
        */}
        <div
          className={cn(
            'absolute inset-0 flex flex-col',
            activeRightTab === 'browser' ? 'z-10' : 'invisible',
          )}
        >
          <BrowserTab />
        </div>
      </div>
    </aside>
  )
}
