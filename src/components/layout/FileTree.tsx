import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileCode,
  FileJson,
  FileText,
  Folder,
  RefreshCw,
  Search,
} from 'lucide-react'
import type { FileNode } from '@/types'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'

/* ══════════════════════════════════════════════════════════════
   FileTree

   图标按扩展名变（tsx/ts → FileCode，json → FileJson，md → FileText）。
   点击文件在右侧「文件」标签里预览。
   ══════════════════════════════════════════════════════════════ */

export interface FileTreeProps {
  root: FileNode
  /** 当前预览的文件 id */
  activeFileId: string | null
  onOpenFile: (node: FileNode) => void
  /**
   * 重新读一遍这棵树（第二阶段新增）。
   *
   * 为什么要手动刷新：树是在**目录变化时**（`effectiveProject.path` 变了）拉的，
   * Agent 在同一目录里新建 / 删除文件不会触发它 —— 用户只能切走再切回来。
   * 给一个明说的按钮，比让界面自己猜「什么时候变了」可靠。
   * 不给就不渲染按钮（测试与预览里不强制接）。
   */
  onRefresh?: () => void | Promise<void>
}

function iconFor(node: FileNode) {
  if (node.type === 'folder') return <Folder size={13} className="shrink-0 text-fg-tertiary" />
  /* 真实文件节点没有 language，只有 path；用扩展名判断 */
  const lang = node.language ?? ''
  const ext = (node.path ?? '').split('.').pop()?.toLowerCase() ?? ''
  if (lang === 'json' || ext === 'json' || ext === 'jsonc')
    return <FileJson size={13} className="shrink-0 text-fg-tertiary" />
  if (lang === 'markdown' || ext === 'md' || ext === 'markdown')
    return <FileText size={13} className="shrink-0 text-fg-tertiary" />
  if (
    lang === 'typescript' ||
    lang === 'tsx' ||
    lang === 'javascript' ||
    ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)
  )
    return <FileCode size={13} className="shrink-0 text-fg-tertiary" />
  return <FileIcon size={13} className="shrink-0 text-fg-tertiary" />
}

function TreeNode({
  node,
  depth,
  activeFileId,
  onOpenFile,
  filter,
}: {
  node: FileNode
  depth: number
  activeFileId: string | null
  onOpenFile: (node: FileNode) => void
  filter: string
}) {
  const [open, setOpen] = useState(depth < 2)

  /* 包一层 useMemo，避免 children 的引用每次渲染都变，导致下面的 childMatches 反复计算 */
  const children = useMemo(() => node.children ?? [], [node.children])
  const selfMatches = filter ? node.name.toLowerCase().includes(filter.toLowerCase()) : true
  const childMatches = useMemo(() => {
    if (!filter) return true
    function walk(n: FileNode): boolean {
      if (n.name.toLowerCase().includes(filter.toLowerCase())) return true
      return (n.children ?? []).some(walk)
    }
    return children.some(walk)
  }, [children, filter])

  /* 搜索时把不相关的分支收起、不隐藏（保留结构感） */
  const visible = !filter || selfMatches || childMatches
  if (!visible) return null

  const isActive = node.id === activeFileId

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (node.type === 'folder') setOpen((v) => !v)
          else onOpenFile(node)
        }}
        aria-expanded={node.type === 'folder' ? open : undefined}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs',
          'transition-colors duration-fast',
          isActive
            ? 'bg-bg-raised text-fg-primary'
            : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {node.type === 'folder' ? (
          open ? (
            <ChevronDown size={12} className="shrink-0 text-fg-tertiary" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-fg-tertiary" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {iconFor(node)}
        <span className="min-w-0 flex-1 truncate" title={node.name}>
          {node.name}
        </span>
      </button>

      {node.type === 'folder' && open && children.length > 0 ? (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              onOpenFile={onOpenFile}
              filter={filter}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function FileTree({ root, activeFileId, onOpenFile, onRefresh }: FileTreeProps) {
  const [filter, setFilter] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  async function refresh(): Promise<void> {
    if (!onRefresh) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pb-2">
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Search
              size={12}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-tertiary"
            />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="按文件名过滤"
              aria-label="过滤文件"
              className="w-full rounded-sm border border-transparent bg-bg-raised/60 py-1.5 pl-6.5 pr-2 text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
              style={{ paddingLeft: 26 }}
            />
          </div>
          {onRefresh ? (
            /* 提示交给 IconButton 自己渲染（hint），别再套一层 Tooltip —— 那正是双框叠一起的老毛病 */
            <IconButton
              label="刷新文件树"
              hint="重新读取目录（同一目录里文件变了之后用）"
              size={28}
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
            </IconButton>
          ) : null}
        </div>
      </div>

      {/*
        这里**不再重复显示工作目录**：
        输入框下面那行已经显示了当前目录，同一份信息出现两处会让人以为是两个不同的目录。
      */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        <TreeNode
          node={root}
          depth={0}
          activeFileId={activeFileId}
          onOpenFile={onOpenFile}
          filter={filter}
        />
      </div>
    </div>
  )
}
