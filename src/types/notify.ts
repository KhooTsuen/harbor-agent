/* ══════════════════════════════════════════════════════════════
   后台任务通知（AG-029）的桥

   单独一个文件而不是塞进 backend.ts：那边已经贴着 300 行，
   而「谁的桥接口住在哪个文件」本来就是这个项目的既有做法
   （见 safety.ts 开头那段说明）。
   ══════════════════════════════════════════════════════════════ */

/**
 * 一轮跑完时的「实际发生了什么」（AG-034）—— 由内核从任务台账判读，
 * 渲染层只按它挑「下一步」的措辞。字段和 `core/task-outcome.cjs`
 * 的 `outcomeOf()` 一一对应。
 */
export interface TaskOutcome {
  /** 这是哪一次任务（判「查看测试结果」展开的是不是同一份结果） */
  taskId: string
  /** 这次改了几个文件 */
  files: number
  /** 测试：没跑过 / 过了 / 没过 / 跑过但读不出结果（老记录） */
  tests: 'none' | 'passed' | 'failed' | 'unknown'
  /** 最后那条测试命令（给「查看测试结果」显示） */
  testCommand: string
  /** 测试输出开头几行 */
  testSummary: string
}

/** 一轮跑完时主进程推过来的内容（文案由内核生成，两边共用一份） */
export interface TaskEndPayload {
  sessionId: string
  kind: 'success' | 'error' | 'info' | 'warning'
  title: string
  description: string
  outcome: TaskOutcome
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
