import { describe, expect, it } from 'vitest'
/* 等页面安静的探针 + 判定（`electron/core/browse-settle.cjs`，2026-10-09）——
   探针脚本在 jsdom 里 eval 真跑一遍，验它真能读页面、真能数 DOM 变动。 */
import {
  PROBE_SCRIPT,
  SETTLE_DEFAULTS,
  stepQuiet,
} from '../../../../../electron/core/browse-settle.cjs'

/** 在 jsdom 里跑一次探针（和主进程经 CDP 跑的是同一段脚本） */
const probe = (): { readyState: string; interactions: number; mutations: number } =>
  eval(PROBE_SCRIPT) as { readyState: string; interactions: number; mutations: number }

/** 清掉持久计数器，让「装 observer」那一步从头来 */
const resetCounter = (): void => {
  delete (window as unknown as Record<string, unknown>).__harborMutCount
}

describe('等页面安静（browse-settle）', () => {
  it('探针报告 readyState 与可交互元素数', () => {
    document.body.innerHTML = '<button>甲</button><a href="#">乙</a><span>丙</span>'
    const p = probe()
    expect(typeof p.readyState).toBe('string')
    /* 按钮 + 链接算可交互，span 不算 */
    expect(p.interactions).toBeGreaterThanOrEqual(2)
  })

  it('DOM 变动会被计数（诊断用；判定不用它，免得动画页面永远等不到安静）', async () => {
    resetCounter()
    probe() /* 第一次探针负责装上 MutationObserver */
    const before = probe().mutations
    document.body.appendChild(document.createElement('div'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(probe().mutations).toBeGreaterThan(before)
  })

  it('★ 还在 loading 不算安静', () => {
    const st = stepQuiet({ sig: null, quiet: 0 }, { readyState: 'loading', interactions: 1 }, 2)
    expect(st.settled).toBe(false)
    expect(st.quiet).toBe(0)
  })

  it('★ 连续同签名到 quietSamples 才算安静；内容一变就重新数', () => {
    let st = stepQuiet({ sig: null, quiet: 0 }, { readyState: 'complete', interactions: 2 }, 2)
    expect(st.settled).toBe(false) /* 第一次只是建立签名 */

    st = stepQuiet({ sig: st.sig, quiet: st.quiet }, { readyState: 'complete', interactions: 2 }, 2)
    expect(st.quiet).toBe(1)
    expect(st.settled).toBe(false)

    st = stepQuiet({ sig: st.sig, quiet: st.quiet }, { readyState: 'complete', interactions: 2 }, 2)
    expect(st.settled).toBe(true)

    /* 元素数一变（SPA 还在填内容）→ 重新计数 */
    const changed = stepQuiet(
      { sig: st.sig, quiet: st.quiet },
      { readyState: 'complete', interactions: 5 },
      2,
    )
    expect(changed.settled).toBe(false)
    expect(changed.quiet).toBe(0)
  })

  it('采样参数有上限，不是无限等', () => {
    expect(SETTLE_DEFAULTS.timeoutMs).toBeGreaterThan(0)
    expect(SETTLE_DEFAULTS.sampleMs).toBeGreaterThan(0)
    expect(SETTLE_DEFAULTS.quietSamples).toBeGreaterThanOrEqual(1)
  })
})
