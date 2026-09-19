/* ══════════════════════════════════════════════════════════════
   后台任务通知（AG-029）的桥

   单独一个文件而不是塞进 backend.ts：那边已经贴着 300 行，
   而「谁的桥接口住在哪个文件」本来就是这个项目的既有做法
   （见 safety.ts 开头那段说明）。
   ══════════════════════════════════════════════════════════════ */

/** 一轮跑完时主进程推过来的内容（文案由内核生成，两边共用一份） */
export interface TaskEndPayload {
  sessionId: string
  kind: 'success' | 'error' | 'info' | 'warning'
  title: string
  description: string
  /** AG-033：这次改了几个文件（决定「下一步」给哪些入口） */
  files: number
}

export interface NotifyBridge {
  /**
   * 一轮跑完了。
   *
   * 注意**不是**渲染层去问「要不要弹系统通知」—— 那个决定在主进程做：
   * 窗口是不是被用户看着（最小化 / 藏托盘 / 被别的窗口盖住）只有它分得清。
   * 这里只是收到同一份文案后，决定要不要弹应用内提示。
   */
  onTaskEnd: (callback: (payload: TaskEndPayload) => void) => () => void

  /** 用户点了系统通知（主进程先把窗口叫回来，再推这条） */
  onNotificationClick: (callback: (payload: { id: string }) => void) => () => void
}
