/**
 * 生图相关的类型
 *
 * 单独一个文件是因为 backend.ts 和 models-extra.ts 都满了（300 行上限），
 * 塞哪边都要再挪别的东西出来。
 */

/** 生图完成/失败时主进程推回来的东西（见 electron/handlers/image.cjs） */
export interface ImageDonePayload {
  taskId: string
  sessionId?: string
  file?: string
  url?: string
  model?: string
  /** 直接就是一条完整的助手消息（含 markdown 图片） */
  content?: string
  error?: string
  /** 进度事件会带这个：submitted / processing / done / failed */
  status?: string
  elapsedMs?: number
}

/** 生图进行中的实时状态（每 3 秒推一次，见 core/image-watch.cjs） */
export interface ImageProgressPayload {
  taskId: string
  sessionId?: string
  /** submitted / processing / completed / failed / done —— 原样来自上游 */
  status?: string
  /** 已经等了多久 */
  elapsedMs?: number
}
