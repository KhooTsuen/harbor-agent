import type { Message } from '@/types'
import { uid } from '@/lib/utils'
import { listSessions, loadSession, removeSession } from '@/lib/backend'
import { appendMessage as appendToDisk } from '@/lib/backend'
import type { StoredMessage } from '@/types/backend'
import { fetchProjects } from '@/lib/projectsApi'
import { groupWorkspace, type DiskWorkspace } from './workspaceGroups'

export { folderIdFor, workdirName } from './folderIds'
export type { DiskWorkspace }

/* ══════════════════════════════════════════════════════════════
   磁盘模式（Electron）—— 这里只管「怎么读盘」

   **一个「对话文件夹」= 一个项目**，归属由会话自己的 `projectId` 决定
   （老会话没有这个字段，内核按 workdir 推导成 `dir:<workdir>`，与升级前一致）：
     · 归属查得到登记项 → 用登记表里的名字/颜色/置顶（见 workspaceGroups.ts）
     · 查不到 → 兜底分组，**不丢会话**
     · 会话没有工作目录 → 不属于任何文件夹，显示在侧栏下半栏（单独对话）

   怎么摆分组在 `./workspaceGroups.ts`（拆出去是为了压住 300 行红线，
   也为了让分组规则能单独测）；「目录 → id / 显示名」在 `./folderIds.ts`。

   消息**懒加载**：侧栏点开才读文件，不然启动时要读一堆 jsonl。
   ══════════════════════════════════════════════════════════════ */

/** 把 jsonl 里存的一条消息还原成界面用的 Message */
export function storedToUi(stored: StoredMessage, threadId: string): Message {
  const isError = Boolean(stored.error)
  return {
    id: uid('msg'),
    /* 磁盘 key 原样带着走：写版本记录时要写回它（不能写重读后的新 uid） */
    ...(typeof stored.key === 'string' && stored.key ? { diskKey: stored.key } : {}),
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
    /* 改过的消息：版本表跟着一起回来，重开还能在几版之间切 */
    ...(stored.versions ? { versions: stored.versions } : {}),
    ...(stored.versionIndex !== undefined ? { versionIndex: stored.versionIndex } : {}),
    ...(stored.versions && stored.versions.length > 1 ? { edited: true } : {}),
    /* 只有快照、没写完（上次进程被打断）—— 界面要说一句，不然用户以为模型就写了这么多 */
    ...(stored.interrupted ? { interrupted: true } : {}),
    /*
     * 回答的「多版本」（内核按 answersKey + answersVersion 分好组了）：
     * 界面靠它显示 ‹ n / N ›，切回答**不重跑**。
     */
    ...(stored.answersKey ? { answersKey: stored.answersKey } : {}),
    ...(stored.answersVersion !== undefined ? { answersVersion: stored.answersVersion } : {}),
    ...(stored.answerRecords?.length ? { answerRecords: stored.answerRecords } : {}),
    ...(stored.answerIndex !== undefined ? { answerIndex: stored.answerIndex } : {}),
    /* 用户选过第几条回答 —— 带着它，切换 / 重开都停在同一个选择上 */
    ...(stored.answerIndexByVersion ? { answerIndexByVersion: stored.answerIndexByVersion } : {}),
    ...(isError ? { errorText: stored.error } : {}),
  }
}

/**
 * 从磁盘读回整个工作区。
 *
 * 会话与项目登记表**并行**读：登记表拿不到（桥没接上 / 校验不过 / 内核报错）
 * 也不影响会话列表 —— `groupWorkspace` 会退回「从 workdir 现推」的老行为，
 * 界面跟升级前**一模一样**，不会白屏。
 *
 * 目录存在与否都保留（盘符可能暂时不在线，拔了 U 盘之后那些对话不该从侧栏消失）。
 */
export async function fetchWorkspaceFromDisk(): Promise<DiskWorkspace> {
  const [all, snapshot] = await Promise.all([listSessions(), fetchProjects()])
  return groupWorkspace(all, snapshot)
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
