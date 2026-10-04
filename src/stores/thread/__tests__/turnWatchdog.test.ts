import { describe, expect, it, vi } from 'vitest'
import { createTurnWatchdog } from '../turnWatchdog'

/* ══════════════════════════════════════════════════════════════
   兜底时钟：判「多久没有新内容」，不判「一共跑了多久」

   来由（2026-10-04 用户报的「超长对话会自行中断，但任务实际却在运行且会完成」）：
   旧实现是 `setTimeout(收尾, 5 分钟)`，**到点无条件收摊** —— 退订事件流、摘掉
   `sendingThreads`、把消息标成「已发送」，而主进程的 agent 循环没有任何人叫停
   （`endTurnRequest` 只删一条登记，真正 abort 的是 `stopActiveRequest`）。
   两回真机长任务分别跑了 280.4 秒 / 171.9 秒，都擦着 5 分钟的边过去 ——
   所以这个 bug 只在**跨过 5 分钟**那一刻才现形。

   这一组把新规矩钉住：
     ① 一直在出内容 → **永不**收尾（只提示一次「还在跑」）；
     ② 从最后一次内容算满 `silenceMs` → 才收尾，且只收一次；
     ③ 收尾之后迟到的事件不该把它复活。
   ══════════════════════════════════════════════════════════════ */

/** 假时钟：手动推进时间，并按时序烧掉到期的定时器 */
function fakeClock() {
  let t = 0
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      id += 1
      timers.set(id, { at: t + ms, fn })
      return id
    },
    clearTimer: (i: number) => {
      timers.delete(i)
    },
    advance(ms: number) {
      const target = t + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, v]) => v.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        t = due[1].at
        timers.delete(due[0])
        due[1].fn()
      }
      t = target
    },
  }
}

const SILENCE = 5 * 60 * 1000
const MIN = 60 * 1000

function setup() {
  const clock = fakeClock()
  const stalls = vi.fn()
  const slows = vi.fn()
  const wd = createTurnWatchdog({
    silenceMs: SILENCE,
    onStall: stalls,
    onSlow: slows,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { clock, stalls, slows, wd }
}

describe('一轮的兜底时钟', () => {
  it('★ 一直在出内容：跑多久都不收尾（旧版到 5 分钟就收摊）', () => {
    const { clock, stalls, slows, wd } = setup()
    for (let i = 0; i < 40; i += 1) {
      clock.advance(4 * MIN) // 每 4 分钟来一段内容 —— 始终没到静默线
      wd.touch()
    }
    expect(stalls).not.toHaveBeenCalled()
    expect(slows).toHaveBeenCalledTimes(1) // 提示只给一次，它不是进度条
    expect(clock.now()).toBe(40 * 4 * MIN)
  })

  it('★ 只是慢：到点还有内容就不收尾，等真的静默满了才收尾', () => {
    const { clock, stalls, slows, wd } = setup()
    clock.advance(4 * MIN)
    wd.touch()
    clock.advance(1 * MIN) // 到第 5 分钟：离最后一次内容才 1 分钟 → 只是慢
    expect(stalls).not.toHaveBeenCalled()
    expect(slows).toHaveBeenCalledWith(5 * MIN)
    clock.advance(4 * MIN) // 到第 9 分钟：从最后一次内容算刚好满 5 分钟 → 收尾
    expect(stalls).toHaveBeenCalledTimes(1)
  })

  it('连续 silenceMs 一个字都没来：收尾，且只收一次', () => {
    const { clock, stalls, wd } = setup()
    wd.touch()
    clock.advance(SILENCE)
    expect(stalls).toHaveBeenCalledTimes(1)
    clock.advance(10 * SILENCE)
    expect(stalls).toHaveBeenCalledTimes(1)
  })

  it('收尾之后迟到的事件不复活它（不会又把界面拖回运行中）', () => {
    const { clock, stalls, wd } = setup()
    clock.advance(SILENCE)
    expect(stalls).toHaveBeenCalledTimes(1)
    wd.touch()
    clock.advance(10 * SILENCE)
    expect(stalls).toHaveBeenCalledTimes(1)
  })

  it('dispose 之后到点也不触发（正常收尾都会调它）', () => {
    const { clock, stalls, wd } = setup()
    wd.dispose()
    clock.advance(10 * SILENCE)
    expect(stalls).not.toHaveBeenCalled()
  })
})
