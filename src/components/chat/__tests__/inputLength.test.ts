import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_INPUT_LENGTH } from '@/constants'
import { useThreadStore } from '@/stores/useThreadStore'

/* ══════════════════════════════════════════════════════════════
   输入框能贴多长（4000 → 100000）

   4000 是初始提交带来的，没有理由记录在案；它的实际效果是「贴一段长日志、
   长报错就贴不进去」。这里钉四件事：

     ① 常量是**唯一来源**（写死 4000/数字的地方会红）；
     ② 10 万字符进得去（不是 4000 就被悄悄切掉）；
     ③ 上限**仍然在**（超过就切到上限 —— 不是无限，理由写在常量的注释里）；
     ④ 输入框的 DOM 上限 / 计数器 / 能否发送三处都跟着同一个常量走。

   ⚠️ 真机上的「卡不卡」不在这里测（jsdom 没有真实排版）—— 那一条是
      `tmp/probe-long-input.js` 在真 Electron 里量的：10 万字符贴进去 49ms、
      再打一个字 29ms、发送时交给内核的 payload 是**完整原文**。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const composerSrc = readFileSync(join(ROOT, 'src/components/chat/Composer.tsx'), 'utf8')
const storeSrc = readFileSync(join(ROOT, 'src/stores/useThreadStore.ts'), 'utf8')
const constantsSrc = readFileSync(join(ROOT, 'src/constants/index.ts'), 'utf8')

beforeEach(() => {
  useThreadStore.getState().setInput('')
})

describe('输入长度上限', () => {
  it('上限是 10 万字符（改它就是产品决定，这条会红给你看）', () => {
    expect(MAX_INPUT_LENGTH).toBe(100000)
  })

  it('★ 1 万字符进得去，一个字符都不少', () => {
    const text = 'x'.repeat(10000)
    useThreadStore.getState().setInput(text)
    expect(useThreadStore.getState().input.length).toBe(10000)
  })

  it('★ 10 万字符进得去（旧上限 4000 会在这里被切成 4000）', () => {
    const text = 'y'.repeat(MAX_INPUT_LENGTH)
    useThreadStore.getState().setInput(text)
    expect(useThreadStore.getState().input.length).toBe(MAX_INPUT_LENGTH)
  })

  it('★ 超过上限仍然被切到上限（不是无限塞）', () => {
    useThreadStore.getState().setInput('z'.repeat(MAX_INPUT_LENGTH + 5000))
    expect(useThreadStore.getState().input.length).toBe(MAX_INPUT_LENGTH)
  })

  it('清空不受影响', () => {
    useThreadStore.getState().setInput('abc')
    useThreadStore.getState().clearInput()
    expect(useThreadStore.getState().input).toBe('')
  })
})

describe('输入长度的接线（常量必须是唯一来源）', () => {
  it('★ store 用常量切，不写死数字', () => {
    expect(storeSrc).toContain('value.slice(0, MAX_INPUT_LENGTH)')
    expect(storeSrc).not.toMatch(/slice\(0,\s*\d{3,}\)/)
  })

  it('★ 输入框的 DOM 上限用常量（不是写死的 4200）', () => {
    expect(composerSrc).toMatch(/maxLength=\{MAX_INPUT_LENGTH\b/)
  })

  it('★ 计数器跟着同一个常量走；到上限是提示，不再拦发送', () => {
    expect(composerSrc).toContain('const atLimit = input.length >= MAX_INPUT_LENGTH')
    expect(composerSrc).toMatch(/\{input\.length\}\/\{MAX_INPUT_LENGTH\}/)
    /* 「能不能发」不再看长度 —— 之前贴满上限会发不出去（真机探针逮到） */
    expect(composerSrc).toContain('const canSend = hasContent')
    expect(composerSrc).not.toContain('const canSend = hasContent && !')
  })

  it('★ 常量定义在 constants 里，注释里写了「为什么不是无限」', () => {
    expect(constantsSrc).toMatch(/export const MAX_INPUT_LENGTH = \d+/)
    expect(constantsSrc).toContain('仍然**不是无限**')
  })
})
