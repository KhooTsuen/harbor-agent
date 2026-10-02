import { describe, expect, it } from 'vitest'
import { clarifyAnswered, clarifyReplyToWire, pickAboveInput, summarizeClarify } from '../clarify'
import type { ClarifyQuestion } from '@/types'

/* ══════════════════════════════════════════════════════════════
   开工前澄清（AG-053）—— 渲染层措辞与「上方只显示一张卡」的仲裁

   这里钉两件在真机上最容易出错、单测却能确定性验掉的事：
     ① 答复的线上格式（`chat:confirm` 那条通道只收字符串）；
     ② **澄清让权限** —— 权限那条往返 5 分钟超时就当拒绝，不能被澄清压在后面。
   ══════════════════════════════════════════════════════════════ */

const questions: ClarifyQuestion[] = [
  {
    question: '用哪个包管理器？',
    options: [
      { label: 'pnpm', effect: '仓库里有 pnpm-lock.yaml，换 npm 会多装 1 份依赖' },
      { label: 'npm', effect: '要重新生成 lock 文件，多花约 30 秒' },
    ],
    allowFreeform: true,
    defaultValue: 'pnpm',
    defaultFrom: 'model',
  },
]

describe('答复的线上格式', () => {
  it('★ 带上问题的原文（内核按 question 对齐答案，靠的是它）', () => {
    const wire = JSON.parse(
      clarifyReplyToWire({
        skipped: false,
        answers: [{ question: '用哪个包管理器？', choice: 'pnpm', text: '  习惯了  ' }],
      }),
    ) as { answers: Array<{ question: string; choice: string; text: string }> }
    expect(wire.answers[0]?.question).toBe('用哪个包管理器？')
    expect(wire.answers[0]?.choice).toBe('pnpm')
  })

  it('超长的补充会被截断（别把一整篇塞进 IPC）', () => {
    const wire = clarifyReplyToWire({
      skipped: false,
      answers: [{ question: 'q', choice: '', text: 'x'.repeat(999) }],
    })
    expect(wire.length).toBeLessThan(600)
  })

  it('跳过时只带 skipped（答案一律清空，别让内核看到半截答案）', () => {
    const wire = JSON.parse(
      clarifyReplyToWire({
        skipped: true,
        answers: [{ question: 'q', choice: 'pnpm', text: 'x' }],
      }),
    ) as { skipped: boolean; answers: Array<{ choice: string; text: string }> }
    expect(wire.skipped).toBe(true)
    expect(wire.answers[0]?.choice).toBe('')
    expect(wire.answers[0]?.text).toBe('')
  })

  /*
   * 两个「退出口」（批⑤）：「先不做了」「换个说法」。
   * ★ 它们和「跳过」共用一条通道（`approved` 只能是 true/false），
   *   所以 `skipped` 也是 true —— 带上的这两个标记就是**唯一的区分**。
   *   字段名写错一个字母不会报错（内核那边静静当跳过），所以把**键名本身**钉住。
   */
  it('★「先不做了」带上 cancelled，且不带 rephrase', () => {
    const wire = JSON.parse(
      clarifyReplyToWire({ skipped: true, answers: [], cancelled: true }),
    ) as Record<string, unknown>
    expect(wire.cancelled).toBe(true)
    expect(wire.rephrase).toBeUndefined()
    expect(Object.keys(wire).sort()).toEqual(['answers', 'cancelled', 'skipped'])
  })

  it('★「换个说法」带上 rephrase', () => {
    const wire = JSON.parse(
      clarifyReplyToWire({ skipped: true, answers: [], rephrase: true }),
    ) as Record<string, unknown>
    expect(wire.rephrase).toBe(true)
    expect(Object.keys(wire).sort()).toEqual(['answers', 'rephrase', 'skipped'])
  })

  it('正常答复不带退出口标记（老形状一个字段不差 —— 老内核照旧能用）', () => {
    const wire = JSON.parse(
      clarifyReplyToWire({
        skipped: false,
        answers: [{ question: 'q', choice: 'pnpm', text: '' }],
      }),
    ) as Record<string, unknown>
    expect(Object.keys(wire).sort()).toEqual(['answers', 'skipped'])
  })

  it('只写了补充（一个字没选）也算答了 —— 「可以只写这个、不选」', () => {
    expect(
      clarifyAnswered({
        skipped: false,
        answers: [{ question: 'q', choice: '', text: '用 yarn' }],
      }),
    ).toBe(true)
    expect(
      clarifyAnswered({ skipped: false, answers: [{ question: 'q', choice: '', text: '   ' }] }),
    ).toBe(false)
    expect(
      clarifyAnswered({ skipped: false, answers: [{ question: 'q', choice: 'pnpm', text: '' }] }),
    ).toBe(true)
  })
})

describe('历史卡片的一句话摘要', () => {
  it('把「选了什么 + 为什么」说清楚（回看时看得懂）', () => {
    const lines = summarizeClarify(questions, {
      skipped: false,
      answers: [{ question: '用哪个包管理器？', choice: 'npm', text: '' }],
    })
    expect(lines[0]).toContain('npm')
    expect(lines[0]).toContain('多花约 30 秒')
  })

  it('跳过的说不出来就写「跳过了」', () => {
    expect(summarizeClarify(questions, { skipped: true, answers: [] })[0]).toContain('跳过')
  })

  it('★「先不做了」不能说成「跳过了」（一个停住了、一个接着干了）', () => {
    const line = summarizeClarify(questions, { skipped: true, answers: [], cancelled: true })[0]
    expect(line).toContain('先不做了')
    expect(line).not.toContain('跳过')
  })

  it('★「换个说法」如实说（他去等重问的那一版了）', () => {
    expect(
      summarizeClarify(questions, { skipped: true, answers: [], rephrase: true })[0],
    ).toContain('换个说法')
  })
})

describe('★ 输入框上方只显示一张卡', () => {
  it('只有权限 → 显示权限', () => {
    expect(pickAboveInput({ permission: true, clarify: false })).toBe('permission')
  })

  it('只有澄清 → 显示澄清', () => {
    expect(pickAboveInput({ permission: false, clarify: true })).toBe('clarify')
  })

  it('都没有 → 什么都不显示', () => {
    expect(pickAboveInput({ permission: false, clarify: false })).toBeNull()
  })

  it('★ 两个都在 → 权限优先（澄清让权限，永不叠）', () => {
    expect(pickAboveInput({ permission: true, clarify: true })).toBe('permission')
  })
})
