import { describe, expect, it } from 'vitest'
import { formatDuration, PROCESS_RUNNING_LABEL, processHeaderText } from '../ProcessPanel'

/* ══════════════════════════════════════════════════════════════
   过程折叠区的入口文案

   ── 为什么把这些钉成单测 ──────────────────────────────────────

   用户先后拍板过三条口径，而它们都是「看起来对但其实错」的高危类型：

     ① **运行中不许报任何计数**（2026-10-21 第三次口径）：
        入口恒为「实时任务」。以前拼 `${runs.length} 个步骤`，
        每调一次工具入口就变一次字，整行跟着跳 —— 用户原话是「不要实时统计」。
     ② **失败必须露在入口上**（「失败 · N 个步骤」）。藏进折叠区等于谎报顺利。
     ③ **中断不能显示成正常完成**（写「已中断」，不写秒数）。

   还有一条附带的：**用时不再进入口**，它挪到展开区第一行（见 ProcessPanel）。
   入口严格只回答「收的是什么、多少步」。

   这些改动单测能整片照过（文案散在 JSX 里时没人测得到），所以抽成纯函数钉住。
   ══════════════════════════════════════════════════════════════ */

const run = (over: Partial<{ ok: boolean; ms: number }> = {}) => ({
  id: 'r',
  name: 'read_file',
  ok: true,
  output: '',
  ms: 100,
  ...over,
})

/** 造 N 条跑完的工具记录（验收表里的「33 个步骤」） */
const runs = (n: number) => Array.from({ length: n }, (_, i) => ({ ...run(), id: `r${i}` }))

describe('formatDuration（毫秒 → 人读的用时）', () => {
  it('★ 不到一分钟给「N 秒」', () => {
    expect(formatDuration(31_000)).toBe('31 秒')
  })

  it('★ 一分钟以上给「N 分 M 秒」', () => {
    expect(formatDuration(6 * 60_000 + 12_000)).toBe('6 分 12 秒')
  })

  it('整分钟不显示多余的 0 秒', () => {
    expect(formatDuration(120_000)).toBe('2 分')
  })

  it('负数不崩（时钟回拨的兜底）', () => {
    expect(formatDuration(-5000)).toBe('0 秒')
  })
})

describe('processHeaderText（入口那一行）', () => {
  it('★★★ 运行中恒为「实时任务」—— 一个计数都不报', () => {
    const text = processHeaderText({ running: true }, runs(7))
    expect(text).toBe(PROCESS_RUNNING_LABEL)
    /* 这条是用户点名的：步骤数跑的时候会一直变，入口不许跟着跳 */
    expect(text).not.toMatch(/步骤|秒|分|失败/)
  })

  it('★★★ 刚发送、一步都还没有 → 也是「实时任务」（不能是空串）', () => {
    expect(processHeaderText({ running: true }, [])).toBe(PROCESS_RUNNING_LABEL)
  })

  it('★★★ 跑完 33 步 → 「33 个步骤」（一次性算出来）', () => {
    expect(processHeaderText({ durationMs: 31_000 }, runs(33))).toBe('33 个步骤')
  })

  it('★★★ 用时不再进入口（挪到展开区第一行）', () => {
    expect(processHeaderText({ durationMs: 31_000 }, runs(2))).not.toMatch(/用时|秒|分/)
  })

  it('★★★ 失败要露在入口上：「失败 · N 个步骤」', () => {
    const text = processHeaderText({ failed: true }, [run(), run({ ok: false })])
    expect(text).toBe('失败 · 2 个步骤')
  })

  it('★★★ 中间失手一次、任务最终完成 → 不能写「失败」（图2 表第二行）', () => {
    /* 一次失败 ≠ 整轮失败：答案已经出来了，入口写成失败等于谎报没完成 */
    const text = processHeaderText({ durationMs: 31_000 }, [run(), run({ ok: false })])
    expect(text).toBe('2 个步骤 · 含 1 项失败')
    expect(text).not.toMatch(/^失败/)
  })

  it('★★★ 每一步都失败 → 那才是整轮失败', () => {
    const text = processHeaderText({}, [run({ ok: false }), run({ ok: false })])
    expect(text).toBe('失败 · 2 个步骤')
  })

  it('★★★ 整轮报错（工具都没失败）也算失败', () => {
    const text = processHeaderText({ failed: true }, runs(3))
    expect(text).toBe('失败 · 3 个步骤')
  })

  it('★★ 还在跑的工具（ms 是 undefined）不算失败', () => {
    const text = processHeaderText({}, [{ id: 'r', name: 'x', ok: true, output: '' }])
    expect(text).not.toContain('失败')
  })

  it('★★ 只有思考没有工具 → 不给空的「0 个步骤」', () => {
    expect(processHeaderText({ durationMs: 5_000 }, [])).toBe('查看过程')
  })

  it('★★★ 中断写「已中断」，且不写秒数（没跑完就谈不上用时）', () => {
    const text = processHeaderText({ interrupted: true, durationMs: 31_000 }, [run()])
    expect(text).toBe('已中断')
    expect(text).not.toMatch(/用时|秒/)
  })

  it('★★ 中断优先于「失败」（被打断不是失败）', () => {
    const text = processHeaderText({ interrupted: true, failed: true }, [run({ ok: false })])
    expect(text).toBe('已中断')
    expect(text).not.toContain('失败')
  })

  it('★★ 跑完那一刻「实时任务」必须消失（不能残留成进行态）', () => {
    expect(processHeaderText({ durationMs: 31_000 }, runs(1))).not.toContain(PROCESS_RUNNING_LABEL)
  })
})
