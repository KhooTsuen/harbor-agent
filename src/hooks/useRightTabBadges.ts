import { useAppStore } from '@/stores/useAppStore'
import { useDownloadsStore } from '@/stores/useDownloadsStore'
import { useErrorsStore } from '@/stores/useErrorsStore'
import { useTaskStore } from '@/stores/useTaskStore'

/* ══════════════════════════════════════════════════════════════
   右栏标签角标的数据（Phase 2 · C）

   抽成 hook 有两个理由：

     ① `RightPanel.tsx` 已经 270+ 行、贴着 300 行红线 —— 角标这件事本身
        就自成一摊（四个 store 的只读订阅），塞进主文件只会更难拆；
     ② 顶栏兜底（`AppTitleBar`）要的是**同几个数**，放一处才只有一个真相源，
        不会「右栏算一套、顶栏再算一套」。

   **只读订阅：没有任何请求、没有定时器** —— 数据全部来自既有 store，
   不新增轮询（省得又变成「空闲也在读磁盘」）。
   ══════════════════════════════════════════════════════════════ */

export interface RightTabBadges {
  /** 「审查」：未提交改动的文件数（0 就不显示） */
  diffCount: number
  /** 「错误」：未读的严重（P0/P1）错误条数（0 就不显示） */
  errorUnread: number
  /** 未读里最严重的一级 —— 角标颜色据此选（仍走 statusLanguage） */
  errorWorst: 'P0' | 'P1' | null
  /** 「任务」：有未完成 / 在跑的任务（「有内容」提示，不是错误） */
  taskPending: boolean
  /** 「下载」：列表里有条目（在进行或已完成待看） */
  downloadsActive: boolean
  /** 「成果」：当前会话内存里确有正式产物 */
  artifactPresent: boolean
  /** 顶栏兜底：**正在跑**的后台任务数 */
  runningTasks: number
  /** P3 #9：「下载」标签是否真有传输在跑（区分「有列表」与「正在传」） */
  downloadRunning: boolean
}

export function useRightTabBadges(): RightTabBadges {
  const diffCount = useTaskStore((s) => s.diff?.files.length ?? 0)
  const errorUnread = useErrorsStore((s) => s.unreadSevere)
  const errorWorst = useErrorsStore((s) => s.worstUnread)

  const taskPending = useTaskStore(
    (s) => s.unfinished.length > 0 || s.tasks.some((t) => t.status === 'running'),
  )
  const runningTasks = useTaskStore((s) => s.tasks.filter((t) => t.status === 'running').length)
  const downloadsActive = useDownloadsStore((s) => s.items.length > 0)
  /*
   * P3 #9：「有列表」不等于「在传」。呼吸光晕只应该给**真在跑**的下载 ——
   * 否则一个已经下完躺在列表里的文件会让那个标签一直闪。
   */
  const downloadRunning = useDownloadsStore(
    (s) => s.running.length > 0 || s.items.some((item) => item.status === 'running'),
  )

  /*
   * 「成果」的「有内容」提示取自**当前对话**内存里的正式产物（消息上的 artifacts）——
   * 纯 selector、零 IPC、零轮询。
   *
   * ★ 范围必须和面板**默认显示范围**一致（面板默认「当前对话」）：
   *   以前这里扫的是 `s.threads.some(...)`（任何对话里有过产物就亮），
   *   于是切到一条什么都没产出的对话，成果标签上仍然亮着点 —— 点开一看是空的。
   *   两个口径对齐之后，「有点」就意味着「这一栏里确实有东西」。
   *
   * 内核那份 `artifact:list`（有版本历史、关掉会话还在）由面板自己去拉：
   * **面板才是成果的真相源**。这个点只表达「里面可能有东西」，不作计数依据。
   */
  const artifactPresent = useAppStore((s) => {
    const active = s.threads.find((t) => t.id === s.activeThreadId)
    return (active?.messages ?? []).some((m) => (m.artifacts?.length ?? 0) > 0)
  })

  return {
    diffCount,
    errorUnread,
    errorWorst,
    taskPending,
    downloadsActive,
    artifactPresent,
    runningTasks,
    downloadRunning,
  }
}
