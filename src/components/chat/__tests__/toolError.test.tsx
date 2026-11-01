import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolRunRow } from '../ToolRuns'
import { errorDigest } from '@/lib/toolError'
import type { ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   失败项的「一句真话」+ 原文次级区域（2026-10-21 图2 验收表）

   用户的原话是「不要只显示『1 个失败』」，图2 又补了两条：
     · 失败项要明显显示失败图标与颜色，可展开看**真实错误原因**
     · **不在主行展示大段原始 JSON**，原始信息放到详情的次级区域

   所以这里钉两件事：
       ① `errorDigest` 能从混杂输出里挑出那一行（且挑不到时敢说「没给原因」）
       ② 明细行默认给那一句，原文要再点一次才铺出来（不是直接铺）
   ══════════════════════════════════════════════════════════════ */

describe('errorDigest（从输出里挑一句能当答案的话）', () => {
  it('★ 纯文本：取第一行非空', () => {
    expect(errorDigest('\n\n退出码 1：找不到命令\n更多信息…').brief).toBe('退出码 1：找不到命令')
  })

  it('★★ JSON 里的错误：挖 message（不是把整段 JSON 当摘要）', () => {
    const out = JSON.stringify({ error: { message: '工具被用户拒绝' }, code: 'DENIED' })
    expect(errorDigest(out).brief).toBe('工具被用户拒绝')
  })

  it('★★ 前面有杂音、JSON 在后面：照样挖得出来', () => {
    const out = `stderr 提示\n{"message":"上游 429"}`
    expect(errorDigest(out).brief).toBe('上游 429')
  })

  it('★ 太长要截断（一句真话，不是一屏）', () => {
    const long = 'x'.repeat(400)
    const { brief } = errorDigest(long)
    expect(brief.length).toBeLessThanOrEqual(201)
    expect(brief.endsWith('…')).toBe(true)
  })

  it('★★★ 一行都没有 → 明说「没给原因」，不编也不留空白', () => {
    expect(errorDigest('   ').brief).toBe('失败，工具没有给出原因')
    expect(errorDigest('').brief).toBe('失败，工具没有给出原因')
  })

  it('★★ 有额外内容时 full 保留原文（一个字都不删）', () => {
    const out = '退出码 1\n第二行\n第三行'
    const { brief, full } = errorDigest(out)
    expect(brief).toBe('退出码 1')
    expect(full).toBe(out)
  })

  it('摘要就等于全部内容时不给「看完整输出」按钮（没东西可展开）', () => {
    expect(errorDigest('一条错').full).toBeNull()
  })
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const failedRun = (output: string): ToolRunRecord => ({
  id: 'f',
  name: 'edit_file',
  ok: false,
  output,
  ms: 18,
  summary: 'ProcessPanel.tsx',
})

function draw(run: ToolRunRecord): HTMLElement {
  act(() => root.render(<ToolRunRow run={run} />))
  return host
}

describe('失败明细行（ToolRunRow）', () => {
  it('★★★ 失败默认摊开，主区域直接给真实错误（不用再点一次）', () => {
    const el = draw(failedRun('找不到预期片段：文件未被本次修改。'))
    const err = el.querySelector('[data-run-error]')
    expect(err).toBeTruthy()
    expect(err?.textContent).toContain('找不到预期片段')
  })

  it('★★★ 大段原始 JSON 不铺在主区域 —— 要点「查看完整输出」才出来', () => {
    const json = JSON.stringify({ error: { message: '文件已被占用' }, stack: 'x'.repeat(500) })
    const el = draw(failedRun(json))
    /* 摘要里是那一句人话 */
    expect(el.textContent).toContain('文件已被占用')
    /* 原文没铺出来（`stack` 那串只存在于完整输出里） */
    expect(el.textContent).not.toContain('xxxx')
    const more = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('查看完整输出'),
    )
    act(() => more?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(el.textContent).toContain('xxxx')
  })

  it('★★ 成功的那一行不出现错误区域（别给一切正常的东西加红字）', () => {
    const el = draw({ id: 'a', name: 'read_file', ok: true, output: 'ok', ms: 3 })
    expect(el.querySelector('[data-run-error]')).toBeNull()
  })

  it('★★ 状态词写在行尾：失败 / 进行中 / 成功（三选一，位置相同）', () => {
    expect(draw(failedRun('x')).querySelector('[data-run-status]')?.textContent).toBe('失败')
    expect(
      draw({ id: 'b', name: 'read_file', ok: true, output: '' }).querySelector('[data-run-status]')
        ?.textContent,
    ).toBe('进行中')
    expect(
      draw({ id: 'c', name: 'read_file', ok: true, output: 'ok', ms: 2 }).querySelector(
        '[data-run-status]',
      )?.textContent,
    ).toBe('成功')
  })
})
