/* ══════════════════════════════════════════════════════════════
   一轮对话的「兜底时钟」—— 从 turns.ts 拆出来（那边贴着 300 行红线）

   2026-10-04 用户报：「超长对话会自行中断，但任务实际却在运行且会完成」。
   当晚两回真机长任务（`tmp/v9-send.cjs` / `tmp/v10-send.cjs`，25 轮 94 次工具 /
   28 轮 68 次工具）把窗口量了出来：**分别跑了 280.4 秒和 171.9 秒**，
   两次界面与后端每一步都同步 —— 也就是说，只有**跨过 5 分钟**那一刻才会现形。

   旧写法的问题不是「时间短」，而是**它只看总时长、不看有没有进展**：
     - 到点就 `finish()`：退订事件流、摘掉 `sendingThreads`、落盘，并把消息标成「已发送」；
     - 而主进程那边**没有任何人叫停**（`endTurnRequest` 只删一条登记，
       真正 `abortChat` 的是 `turnControl.stopActiveRequest`）——
       于是界面死了、后台还在写，用户看到的就是「它自己中断了，可任务最后又完成了」。

   新规矩：**判的是「多久没有新内容」，不是「一共跑了多久」**。
     · 还在出内容 → 只是慢：重新排一次，最多提示一句，**绝不**收尾；
     · 连续 `silenceMs` 一个字都没来 → 才收尾，文案也说清是「没有新内容」。
   ══════════════════════════════════════════════════════════════ */

import { useUIStore } from '../useUIStore'

/** 取时与计时器（可注入 —— 测试不必等 5 分钟真时间） */
export interface TurnWatchdogClock {
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

export interface TurnWatchdogOptions extends TurnWatchdogClock {
  /** 连续多久没有新内容才算「卡住」（旧语义里它是「一轮最多跑多久」） */
  silenceMs: number
  /** 真卡住了：收尾。**调用方自己决定要不要停主进程**（这里只负责判定） */
  onStall: () => void
  /** 还在出内容、但已经跑了很久 —— 只提示，**不**收尾（默认给一句 toast，测试可注入） */
  onSlow?: (elapsedMs: number) => void
}

export interface TurnWatchdog {
  /** 每收到一个流式事件就调一次（便宜到可以无脑调） */
  touch(): void
  /** 这一轮结束了（正常 / 失败 / 用户停止都算）—— 别让它继续数 */
  dispose(): void
}

export function createTurnWatchdog(opts: TurnWatchdogOptions): TurnWatchdog {
  const now = opts.now ?? (() => Date.now())
  const setTimer = opts.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((id) => window.clearTimeout(id))
  /*
   * 默认的「只是慢」提示：它同时在告诉用户「别关，界面没死」——
   * 旧版这里不但不提示，反而直接收摊（用户就是这么看到的）。
   */
  const slowNotice =
    opts.onSlow ??
    ((elapsedMs: number) =>
      useUIStore
        .getState()
        .showToast(
          'info',
          '这一轮跑得比较久',
          `已经 ${Math.round(elapsedMs / 60000)} 分钟，一直在出内容，继续等就行`,
        ))

  const startedAt = now()
  let lastAt = startedAt
  /* 「只是慢」的提示一轮最多一次 —— 它是给「界面看着像死了」兜底的，不是进度条 */
  let slowNoticed = false
  let stopped = false
  let timerId = 0

  /*
   * 每次到点只做一件事：量一下「离上次有内容过了多久」。
   * 还有动静就按剩余时间重排 —— 这样卡住判定永远发生在「最后一次内容 + silenceMs」那一刻。
   */
  function check(): void {
    if (stopped) return
    const silent = now() - lastAt
    if (silent >= opts.silenceMs) {
      stopped = true
      opts.onStall()
      return
    }
    if (!slowNoticed) {
      slowNoticed = true
      slowNotice(now() - startedAt)
    }
    timerId = setTimer(check, opts.silenceMs - silent)
  }

  timerId = setTimer(check, opts.silenceMs)

  return {
    touch() {
      if (stopped) return
      lastAt = now()
    },
    dispose() {
      stopped = true
      clearTimer(timerId)
    },
  }
}
