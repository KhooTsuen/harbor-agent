import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { nextSmoothLength } from '@/hooks/useSmoothText'

/* 内核是 CJS，vitest 能直接 require，但 TS 不认 —— 走 createRequire */
const requireCjs = createRequire(import.meta.url)
const { createBatcher } = requireCjs('../../../electron/core/stream-batch.cjs') as {
  createBatcher: (o: { send: (type: string, text: string) => void; flushMs?: number }) => {
    put: (type: string, text: string) => void
    flush: () => void
    pending: string
  }
}

/* ══════════════════════════════════════════════════════════════
   AG-023：流式显示的「流水感」

   用户反馈「想要顺畅的流水式」。查下来是两个独立的毛病：

   ① **后端定时器被事件循环推迟**。原来靠 `setTimeout(flush, 50)`，
      真机实测（打字时开日志）变成了：

          04:52:00.319  flush content   8 字
          04:52:01.459  flush content 369 字   ← 1.14 秒后
          04:52:02.607  flush content 588 字   ← 1.15 秒后

      修法：按**时间**判断该不该发，定时器只做兜底。

   ② **上游本身一阵一阵**（SSE 缓冲/网络抖动，实测间隔 51ms~1187ms）。
      这后端救不了，只能在前端把不均匀的批次**摊到帧上**。

   这个文件就守这两件事。
   ══════════════════════════════════════════════════════════════ */

describe('AG-023 后端：不靠定时器决定节奏', () => {
  it('★ 距上次发出够久就当场发，不等定时器', () => {
    const sent: string[] = []
    /* flushMs 设 0：任何一次 put 都该立刻发出去 */
    const b = createBatcher({ send: (_t: string, text: string) => sent.push(text), flushMs: 0 })
    b.put('content', '甲')
    expect(sent).toEqual(['甲'])
    b.put('content', '乙')
    expect(sent).toEqual(['甲', '乙'])
    /* 没有攒着的东西了 */
    expect(b.pending).toBe('')
  })

  it('同类型会攒起来（没到时间就不发）', () => {
    const sent: string[] = []
    const b = createBatcher({
      send: (_t: string, text: string) => sent.push(text),
      flushMs: 10_000,
    })
    b.put('content', '甲')
    b.put('content', '乙')
    b.put('content', '丙')
    expect(sent).toEqual([])
    expect(b.pending).toBe('甲乙丙')
    b.flush()
    expect(sent).toEqual(['甲乙丙'])
  })

  it('★ 换类型先冲一次（顺序不能乱）', () => {
    const sent: Array<[string, string]> = []
    const b = createBatcher({
      send: (t: string, text: string) => sent.push([t, text]),
      flushMs: 10_000,
    })
    b.put('content', '甲')
    b.put('reasoning', '乙')
    expect(sent).toEqual([['content', '甲']])
    expect(b.pending).toBe('乙')
  })

  it('flush 可重复调（收尾时会调好几次）', () => {
    const sent: string[] = []
    const b = createBatcher({
      send: (_t: string, text: string) => sent.push(text),
      flushMs: 10_000,
    })
    b.put('content', '甲')
    b.flush()
    b.flush()
    b.flush()
    expect(sent).toEqual(['甲'])
  })
})

describe('AG-023 前端：把不均匀的批次摊到帧上', () => {
  it('追上就停（不会倒欠）', () => {
    expect(nextSmoothLength(10, 10)).toBe(10)
    expect(nextSmoothLength(20, 10)).toBe(10)
  })

  it('差距小的时候一帧一个（这就是「流水」）', () => {
    expect(nextSmoothLength(0, 1)).toBe(1)
    expect(nextSmoothLength(0, 5)).toBe(1)
    expect(nextSmoothLength(0, 10)).toBe(1)
  })

  it('★ 差距大就追得快（上游一次甩 588 字也不至于打半分钟）', () => {
    /* 差 10 字时一帧 1 个；差 588 字时一帧 59 个 —— 差距越大补得越多 */
    expect(nextSmoothLength(0, 10)).toBe(1)
    expect(nextSmoothLength(0, 588)).toBe(59)

    /*
     * 收敛速度：每帧补 `gap/10`，差距按 0.9 递减（指数收敛）。
     * 追上 588 字约需 60 帧（1 秒）—— 也就是 588 字/秒，
     * 比模型实际输出（实测 ~56 字/秒）快十倍，所以不会「越拖越久」。
     */
    let len = 0
    let frames = 0
    while (len < 588 && frames < 300) {
      len = nextSmoothLength(len, 588)
      frames += 1
    }
    expect(frames).toBeLessThanOrEqual(90) // 1.5 秒以内
  })

  it('永远单调前进，不会回退', () => {
    let len = 0
    for (let i = 0; i < 50; i += 1) {
      const next = nextSmoothLength(len, 100)
      expect(next).toBeGreaterThanOrEqual(len)
      len = next
    }
    expect(len).toBe(100)
  })

  it('★ 不论差距多大，都能在 1.5 秒（90 帧）内追上', () => {
    for (const target of [1, 13, 57, 200, 2000]) {
      let len = 0
      let frames = 0
      while (len < target && frames < 300) {
        len = nextSmoothLength(len, target)
        frames += 1
      }
      expect(frames).toBeLessThanOrEqual(90)
    }
  })
})
