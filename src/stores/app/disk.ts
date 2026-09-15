import type { Message, Project, Thread, ThreadMode } from '@/types'
import { uid } from '@/lib/utils'
import { listSessions, loadSession, removeSession } from '@/lib/backend'
import { appendMessage as appendToDisk } from '@/lib/backend'
import type { StoredMessage } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   磁盘模式（Electron）

   **一个「对话文件夹」= 一个工作目录。** 不再只有一个项目：
   每条会话自己记着 workdir，侧栏按它分成多个文件夹。
   workdir 为空的会话不属于任何文件夹，显示在侧栏下半栏（单独对话）。

   消息**懒加载**：侧栏点开才读文件，不然启动时要读一堆 jsonl。
   ══════════════════════════════════════════════════════════════ */

/** 把 jsonl 里存的一条消息还原成界面用的 Message */
export function storedToUi(stored: StoredMessage, threadId: string): Message {
  const isError = Boolean(stored.error)
  return {
    id: uid('msg'),
    threadId,
    role: stored.role === 'tool' ? 'system' : stored.role,
    content: stored.content,
    kind: isError ? 'error' : 'text',
    status: isError ? 'error' : 'sent',
    timestamp: stored.ts ?? Date.now(),
    ...(stored.toolRuns && stored.toolRuns.length > 0 ? { toolRuns: stored.toolRuns } : {}),
    ...(stored.citations && stored.citations.length > 0 ? { citations: stored.citations } : {}),
    ...(stored.artifacts && stored.artifacts.length > 0 ? { artifacts: stored.artifacts } : {}),
    ...(stored.usage ? { usage: stored.usage } : {}),
    ...(isError ? { errorText: stored.error } : {}),
  }
}

/** 目录 → 显示名（取最后一段；根目录显示成整个路径） */
export function workdirName(workdir: string): string {
  const normalized = String(workdir)
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
  const last = normalized.split('/').filter(Boolean).pop()
  return last || workdir || '本地'
}

/** 文件夹的稳定 id：挂在目录上，换机器/换盘符也还是同一个 */
export function folderIdFor(workdir: string): string {
  return `dir:${workdir}`
}

/** 会话列表 → 界面 Thread（懒加载 messages） */
function toThread(item: {
  id: string
  title: string
  mode?: string
  model?: string
  workdir?: string
  threadSettings?: Thread['settings']
  messageCount: number
  createdAt: number
  updatedAt: number
}): Thread {
  const workdir = typeof item.workdir === 'string' ? item.workdir : ''
  return {
    id: item.id,
    /* 空 workdir → 不属于任何文件夹（侧栏下半栏） */
    projectId: workdir ? folderIdFor(workdir) : '',
    workdir,
    title: item.title,
    messages: [],
    status: 'idle',
    mode: (item.mode as ThreadMode) ?? 'pair',
    model: item.model ?? '',
    reasoning: 'medium',
    ...(item.threadSettings ? { settings: item.threadSettings } : {}),
    pinned: false,
    archived: false,
    tags: [],
    exportedAt: 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

export interface DiskWorkspace {
  /** 有会话的目录 → 一个文件夹 */
  folders: Array<{ project: Project; threads: Thread[] }>
  /** 不属于任何文件夹的会话 */
  loose: Thread[]
  /** 全部会话（上面两者拼起来），store 里只用这一份 */
  threads: Thread[]
}

/**
 * 从磁盘读回整个工作区。
 *
 * 分组只按 workdir，不去猜：目录存在与否都保留（盘符可能暂时不在线，
 * 拔了 U 盘之后那些对话不该从侧栏消失）。
 */
export async function fetchWorkspaceFromDisk(): Promise<DiskWorkspace> {
  const all = await listSessions()

  const byFolder = new Map<string, Thread[]>()
  const loose: Thread[] = []

  for (const item of all) {
    const thread = toThread(item)
    if (!thread.workdir) {
      loose.push(thread)
      continue
    }
    const list = byFolder.get(thread.workdir) ?? []
    list.push(thread)
    byFolder.set(thread.workdir, list)
  }

  const folders = [...byFolder.entries()]
    .map(([workdir, threads]) => ({
      project: {
        id: folderIdFor(workdir),
        name: workdirName(workdir),
        description: '工作目录',
        path: workdir,
        branch: 'main',
        icon: '',
        color: '',
        pinned: false,
        archived: false,
        createdAt: Math.min(...threads.map((t) => t.createdAt)),
        updatedAt: Math.max(...threads.map((t) => t.updatedAt)),
      } satisfies Project,
      threads,
    }))
    /* 最近动过的文件夹排前面 */
    .sort((a, b) => b.project.updatedAt - a.project.updatedAt)

  return {
    folders,
    loose,
    threads: [...folders.flatMap((f) => f.threads), ...loose],
  }
}

/** 读某个会话的完整消息 */
export async function fetchMessagesFromDisk(id: string): Promise<Message[] | null> {
  const detail = await loadSession(id)
  if (!detail) return null

  const messages = detail.messages.map((m) => storedToUi(m, id))

  /*
   * 压缩点也还原成一条消息，放在最前面。
   * 位置不追求精确（摘要覆盖到第几条在 UI 里已经不好对应了），
   * 关键是让用户「重开这个会话时看得出它被压过」——否则会以为丢消息了。
   */
  const markers: Message[] = (detail.compacts ?? []).map((c) => ({
    id: uid('compact'),
    threadId: id,
    role: 'system',
    content: `已压缩前 ${c.upTo} 条对话（之后会以摘要形式带上）`,
    kind: 'text',
    status: 'sent',
    timestamp: c.ts,
    /* 摘要挂在 reasoning 上，点开压缩点就能看 */
    reasoning: c.summary,
  }))

  return [...markers, ...messages]
}

/** 删会话文件（磁盘模式） */
export { removeSession, appendToDisk }
export type { StoredMessage }
