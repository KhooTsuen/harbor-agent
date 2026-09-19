import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentPhase } from '@/types'
import {
  STATUS_META,
  colorOf,
  labelOf,
  statusOfPhase,
  statusOfStep,
  statusOfTask,
  statusOfToast,
  statusOfTool,
} from '../statusLanguage'

/* ══════════════════════════════════════════════════════════════
   状态视觉语言（AG-031）

   文档：Running / Completed / Warning / Failed / Paused / Retrying /
   Waiting / Cancelled 这八种语义，**所有页面用同一套**。

   这里除了测映射本身，还守一条规矩：**组件里不许自己写语义色**。
   以前 `var(--success)` / `var(--danger)` / `var(--warning)` 散在 10 个文件里，
   同一份状态在不同页面长得不一样。想改颜色只能改 statusLanguage.ts。
   ══════════════════════════════════════════════════════════════ */

/** 读源码时先把注释剥掉 —— 否则注释里提一句 `var(--success)` 就会误判 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue
      walk(full, out)
    } else if (/\.tsx?$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

describe('AG-031 / 状态语言表', () => {
  it('文档点名的八种语义都在，而且各有措辞与颜色', () => {
    const required = [
      'running',
      'completed',
      'warning',
      'failed',
      'paused',
      'retrying',
      'waiting',
      'cancelled',
    ] as const
    for (const status of required) {
      expect(STATUS_META[status], status).toBeTruthy()
      expect(STATUS_META[status].label.length, status).toBeGreaterThan(0)
      expect(STATUS_META[status].color, status).toMatch(/^var\(--[a-z-]+\)$/)
      expect(STATUS_META[status].icon, status).toBeTruthy()
    }
  })

  it('任务的六种状态都有对应语义，措辞只有一份', () => {
    expect(statusOfTask('running')).toBe('running')
    expect(statusOfTask('waiting_user')).toBe('waiting')
    expect(statusOfTask('completed')).toBe('completed')
    expect(statusOfTask('failed')).toBe('failed')
    expect(statusOfTask('paused')).toBe('paused')
    expect(statusOfTask('cancelled')).toBe('cancelled')
    /* 「等待中」只有这一个说法 —— 以前状态页叫「等你确认」 */
    expect(labelOf(statusOfTask('waiting_user'))).toBe('等待中')
  })

  it('相位映射到语义，而不是各页面自己判', () => {
    const running: AgentPhase[] = [
      'preparing',
      'thinking',
      'planning',
      'executing',
      'verifying',
      'responding',
    ]
    for (const phase of running) expect(statusOfPhase(phase), phase).toBe('running')
    expect(statusOfPhase('retrying')).toBe('retrying')
    expect(statusOfPhase('waiting_user')).toBe('waiting')
    expect(statusOfPhase('paused')).toBe('paused')
    expect(statusOfPhase('completed')).toBe('completed')
    expect(statusOfPhase('failed')).toBe('failed')
    expect(statusOfPhase('cancelled')).toBe('cancelled')
    /* 空闲 / 还没有相位 = 中性灰，不是「已完成」 */
    expect(statusOfPhase('idle')).toBe('neutral')
    expect(statusOfPhase(undefined)).toBe('neutral')
  })

  it('步骤 / 工具 / 轻提示用同一套语义', () => {
    expect(statusOfStep('failed')).toBe('failed')
    expect(statusOfStep('done')).toBe('completed')
    expect(statusOfStep('current')).toBe('running')
    expect(statusOfStep('active')).toBe('running')
    expect(statusOfStep('todo')).toBe('neutral')
    expect(statusOfTool(true)).toBe('completed')
    expect(statusOfTool(false)).toBe('failed')
    expect(statusOfToast('success')).toBe('completed')
    expect(statusOfToast('error')).toBe('failed')
    expect(statusOfToast('warning')).toBe('warning')
    expect(statusOfToast('info')).toBe('neutral')
  })

  it('★ 语义和颜色的对应关系钉死（成功不能画成失败色）', () => {
    expect(colorOf('completed')).toBe('var(--success)')
    expect(colorOf('failed')).toBe('var(--danger)')
    expect(colorOf('warning')).toBe('var(--warning)')
    expect(colorOf('running')).toBe('var(--accent-blue)')
  })

  it('★ 该能区分的语义必须是不同颜色（措辞与颜色都不同才算分清）', () => {
    const distinct = ['completed', 'failed', 'warning', 'neutral'] as const
    expect(new Set(distinct.map((status) => colorOf(status))).size).toBe(distinct.length)
    /*
     * 有意共用颜色的两对（措辞与图标区分得开）：
     *   paused / retrying 共用警告色（都是「停着，但没死」）
     *   running / waiting 共用强调色（都是「活着」）
     */
    expect(colorOf('paused')).toBe(colorOf('warning'))
    expect(colorOf('running')).toBe(colorOf('waiting'))
  })

  it('同一种语义在任何页面拿到同一个颜色', () => {
    /* 「完成」不管从哪来，颜色必须一致 —— 这正是 AG-031 要的 */
    const fromTask = colorOf(statusOfTask('completed'))
    const fromStep = colorOf(statusOfStep('done'))
    const fromToast = colorOf(statusOfToast('success'))
    const fromTool = colorOf(statusOfTool(true))
    expect(new Set([fromTask, fromStep, fromToast, fromTool]).size).toBe(1)
  })
})

describe('AG-031 / 执法：语义色只能来自状态语言表', () => {
  it('★ 组件里不再自己写 --success / --danger / --warning', () => {
    const offenders: string[] = []
    for (const file of walk(join(__dirname, '..', '..'))) {
      /* 状态语言表自己就是那份「唯一允许写语义色」的地方 */
      if (file.endsWith('statusLanguage.ts')) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      const hit = code.match(/var\(--(success|danger|warning)\)/)
      if (hit) offenders.push(`${file.split('components')[1] ?? file} → ${hit[0]}`)
    }
    expect(offenders, `这些文件该改用 lib/statusLanguage.ts：\n${offenders.join('\n')}`).toEqual([])
  })

  it('★ 状态词也只有一份（组件里不再抄「已暂停 / 等待中」这类词）', () => {
    const offenders: string[] = []
    /* 允许出现的例外：任务中心的分组标题（取自状态表，写的是变量）等 */
    const banned = ['等你确认', '已放弃']
    for (const file of walk(join(__dirname, '..', '..'))) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const word of banned) {
        if (code.includes(`'${word}'`) || code.includes(`>${word}<`)) {
          offenders.push(`${file.split('components')[1] ?? file} → ${word}`)
        }
      }
    }
    expect(offenders, `这两套旧说法已经并进状态表了：\n${offenders.join('\n')}`).toEqual([])
  })
})
