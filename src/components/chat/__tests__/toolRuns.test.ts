import { describe, expect, it } from 'vitest'
import type { ToolRunRecord } from '@/types'
import { groupRuns } from '../ToolRuns'

/* ══════════════════════════════════════════════════════════════
   工具调用归类

   一口气读十个文件不该是十行卡片。但归类得谨慎 ——
   把不该合的合了，比不合更糟（让人以为是一起干的）。
   ══════════════════════════════════════════════════════════════ */

let seq = 0
const run = (name: string, ok = true, ms = 100): ToolRunRecord => ({
  id: `t${seq++}`,
  name,
  ok,
  ms,
  output: '',
})

describe('groupRuns', () => {
  it('连续的同名调用归成一组', () => {
    const groups = groupRuns([run('read_file'), run('read_file'), run('read_file')])
    expect(groups).toHaveLength(1)
    expect(groups[0].runs).toHaveLength(3)
  })

  it('★ 不同工具不混在一起', () => {
    expect(groupRuns([run('read_file'), run('run_shell')])).toHaveLength(2)
  })

  it('★ 不连续的同类调用不合并（中间夹了别的活）', () => {
    expect(groupRuns([run('read_file'), run('run_shell'), run('read_file')])).toHaveLength(3)
  })

  it('★ 失败的不和成功归一组（失败得看得见）', () => {
    const groups = groupRuns([run('read_file', true), run('read_file', false)])
    expect(groups).toHaveLength(2)
    expect(groups[0].ok).toBe(true)
    expect(groups[1].ok).toBe(false)
  })

  it('组内耗时是累加的', () => {
    const groups = groupRuns([run('read_file', true, 100), run('read_file', true, 250)])
    expect(groups[0].totalMs).toBe(350)
  })

  it('空输入返回空', () => {
    expect(groupRuns([])).toEqual([])
  })
})
