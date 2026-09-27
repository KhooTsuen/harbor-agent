import type { Message } from '@/types'
import type { StoredMessage } from '@/types/backend'

/**
 * 用户消息的**落盘形态**。
 *
 * 单独抽出来有两个原因：
 *   ① `useThreadStore.ts` 贴着 300 行红线（这段一塞就破）；
 *   ② 这段逻辑必须能单独测 —— 它出过一次真机事故。
 *
 * ★ `images` 必须跟着落盘（2026-09-28 真机复现）：
 *   以前只写 `content: '（图片）'`，于是**重开会话只剩那行占位字** ——
 *   缩略图没了，模型也再收不到画面（「恢复任务」走的 `session.toApiMessages`
 *   同样只看这条记录）。写进来之后，读侧（`stores/app/disk.ts` 的 `storedToUi`）
 *   与内核（`session-read.cjs` 的 `contentOf`）各自负责还原成多模态。
 *
 * `key` 也要带上：编辑这条时会在**同一个 key** 上追加新记录，读的时候收敛成一条
 * （不然「改一次就多一条提问」会从界面跑到磁盘上）。
 */
export function userRecord(
  message: Message,
  parent?: { key: string; version: number } | null,
): StoredMessage {
  return {
    role: 'user',
    key: message.id,
    content: message.content || '（图片）',
    ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
    ts: message.timestamp,
    ...(parent ? { parentKey: parent.key, parentVersion: parent.version } : {}),
  }
}
