import type { Project, ReasoningLevel, Thread, ThreadMode } from '@/types'
import type { SessionSummary } from '@/types/models-extra'
import type { ProjectRecord, ProjectsSnapshot } from '@/types/projects'
import { folderIdFor, workdirName } from './folderIds'

/* ══════════════════════════════════════════════════════════════
   会话 + 项目登记表 → 侧栏要的分组

   从 `disk.ts` 拆出来的：那边管「怎么读盘」，这里管「怎么摆」。
   拆的理由有两个 ——
     · `disk.ts` 加上登记表逻辑就顶到 300 行红线了；
     · 分组规则（置顶优先、查不到登记项时兜底）值得单独看，不该埋在 I/O 里。
   这里**不碰 IPC、不碰 store**，纯函数，所以能单独测。

   ⚠️ 分组依据是**会话自己的 `projectId`**，不再从 workdir 现推：
     老会话的 projectId 由内核按 workdir 推导（`dir:<workdir>`，与升级前逐字一致），
     新会话建的时候就写死了 —— 所以「项目改名」不会让归属变。
   ══════════════════════════════════════════════════════════════ */

export interface DiskWorkspace {
  /** 有会话的目录 / 手建的空项目 → 一个文件夹 */
  folders: Array<{ project: Project; threads: Thread[] }>
  /** 不属于任何文件夹的会话 */
  loose: Thread[]
  /** 全部会话（上面两者拼起来），store 里只用这一份 */
  threads: Thread[]
  /**
   * 上次选中的项目。**已经失效（登记项被删了）时给空串** —— 调用方据此回退到第一个，
   * 而不是把界面顶在一个不存在的项目上。
   */
  activeId: string
}

/**
 * 会话摘要 + 内核补充的字段。
 *
 * 单独声明（而不是往 `SessionSummary` 里加）有两个原因：
 *   · 那个类型住在 `types/models-extra.ts`，而那个文件正好 300 行（硬约束 #2，加一行就破线）；
 *   · `reasoning` 本来就没写进 `SessionSummary`（以前这里用的是内联结构类型），
 *     而会话列表确实会返回它。
 */
type SessionRow = SessionSummary & { projectId?: string; reasoning?: string }

/** 会话列表 → 界面 Thread（懒加载 messages） */
function toThread(item: SessionRow): Thread {
  const workdir = typeof item.workdir === 'string' ? item.workdir : ''
  /*
   * 归属优先用内核给的 `projectId`（老会话由内核按 workdir 推导）。
   * 万一没有（老内核 / 用户手改过 meta）就自己按 workdir 推 —— 结果完全一致
   * （`folderIdFor` 与内核 `dirIdFor` 逐字相同），所以这条路不会把会话摆错地方。
   */
  const projectId =
    typeof item.projectId === 'string' && item.projectId
      ? item.projectId
      : workdir
        ? folderIdFor(workdir)
        : ''
  return {
    id: item.id,
    /* 空 projectId → 不属于任何文件夹（侧栏下半栏） */
    projectId,
    workdir,
    title: item.title,
    messages: [],
    status: 'idle',
    mode: (item.mode as ThreadMode) ?? 'pair',
    model: item.model ?? '',
    /* 以前这里硬编码 'medium'，从不读盘 —— 所以档位重启就丢 */
    reasoning: (item.reasoning as ReasoningLevel) || 'high',
    ...(item.threadSettings ? { settings: item.threadSettings } : {}),
    pinned: false,
    archived: false,
    tags: [],
    exportedAt: 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

/** 登记项 → 界面用的 Project（字段名对不上：内核叫 root，界面叫 path） */
export function projectFromRecord(record: ProjectRecord): Project {
  return {
    id: record.id,
    /* 名字可能是空的（老数据）—— 退回目录名，别在侧栏显示一条没有标题的分组 */
    name: record.name || workdirName(record.root) || '未命名项目',
    description: record.description,
    path: record.root,
    branch: record.branch || 'main',
    icon: record.icon,
    color: record.color,
    pinned: Boolean(record.pinned),
    archived: Boolean(record.archived),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * 「项目被移除 / 还没登记」时的兜底分组 —— 名字取目录最后一段。
 *
 * 导出是给 `deleteProject` 用的：移除登记项之后那些会话**一个字节都没删**，
 * 但它们的 projectId 指向一个已经不存在的项目，侧栏按 `projects` 遍历就渲染不出来。
 * 就地补一个兜底分组，它们立刻落到和「重新读盘」一样的那一栏，而不是凭空消失。
 */
export function fallbackProjectFor(id: string, threads: Thread[]): Project {
  const workdir = threads.find((t) => t.workdir)?.workdir ?? ''
  /* 两个调用点传进来的都是非空列表（分组时按 projectId 聚过，删项目时判过 orphans） */
  const span = spanOf(threads) ?? { createdAt: Date.now(), updatedAt: Date.now() }
  return {
    id,
    name: workdirName(workdir) || '未归类',
    description: '未归类',
    path: workdir,
    branch: 'main',
    icon: '',
    color: '',
    pinned: false,
    archived: false,
    createdAt: span.createdAt,
    updatedAt: span.updatedAt,
  }
}

/**
 * 一组会话覆盖的时间范围；空组返回 null（**不能给「现在」** —— 那样每个文件夹的
 * `updatedAt` 都变成同一时刻，侧栏的「最近动过的在前」就静默失效了）。
 */
function spanOf(threads: Thread[]): { createdAt: number; updatedAt: number } | null {
  if (threads.length === 0) return null
  return {
    createdAt: Math.min(...threads.map((t) => t.createdAt)),
    updatedAt: Math.max(...threads.map((t) => t.updatedAt)),
  }
}

/**
 * 侧栏排序用的时间。
 *
 * **有会话的**按会话的实际活动算（与升级前逐字一致）—— 不能用登记项的 `updatedAt`：
 * 那个值在内核里每次 patch 都会刷新（改个名字也算），用它会变成「重命名一下项目
 * 就跳到最上面」，而用户的心智模型是「最近聊过的在前面」。
 * 空项目（用户手建的，还没建对话）只有登记项的时间可用，就照用。
 */
function withSpan(project: Project, threads: Thread[]): Project {
  const span = spanOf(threads)
  if (!span) return project
  return { ...project, createdAt: span.createdAt, updatedAt: span.updatedAt }
}

/** 目录存在与否都保留（盘符可能暂时不在线，拔了 U 盘之后那些对话不该从侧栏消失） */
export function groupWorkspace(
  all: readonly SessionRow[],
  snapshot: ProjectsSnapshot | null,
): DiskWorkspace {
  const records = new Map<string, ProjectRecord>()
  for (const item of snapshot?.items ?? []) records.set(item.id, item)

  const byProject = new Map<string, Thread[]>()
  const loose: Thread[] = []

  for (const raw of all) {
    const thread = toThread(raw)
    if (!thread.projectId) {
      loose.push(thread)
      continue
    }
    const list = byProject.get(thread.projectId) ?? []
    list.push(thread)
    byProject.set(thread.projectId, list)
  }

  const folders: DiskWorkspace['folders'] = []
  for (const [id, threads] of byProject) {
    const record = records.get(id)
    /* 查不到登记项 —— **别丢会话**，用兜底分组显示出来 */
    folders.push({
      project: record ? projectFromRecord(record) : fallbackProjectFor(id, threads),
      threads,
    })
  }

  /*
   * 登记表里**没有会话的项目**也要出现在侧栏：
   用户手建的（`auto === false`）是他明确要的东西，重启后不能消失 ——
   这正是「新建项目不落盘、重启就没了」要修的毛病。
   跟着目录自动登记的（`auto`）没会话就不显示：删光一个目录的对话之后，
   侧栏不该留下一个空壳文件夹（老行为里它本来就不存在）。
   */
  if (snapshot) {
    for (const record of snapshot.items) {
      if (record.auto || byProject.has(record.id)) continue
      folders.push({ project: projectFromRecord(record), threads: [] })
    }
  }

  const stamped = folders.map((folder) => ({
    threads: folder.threads,
    project: withSpan(folder.project, folder.threads),
  }))

  /* 置顶的在前，其余按最近动过 —— 与升级前一致（那时 pinned 恒为 false） */
  stamped.sort((a, b) => {
    if (a.project.pinned !== b.project.pinned) return a.project.pinned ? -1 : 1
    return b.project.updatedAt - a.project.updatedAt
  })

  const wanted = snapshot?.activeId ?? ''
  return {
    folders: stamped,
    loose,
    threads: [...stamped.flatMap((f) => f.threads), ...loose],
    activeId: stamped.some((f) => f.project.id === wanted) ? wanted : '',
  }
}
