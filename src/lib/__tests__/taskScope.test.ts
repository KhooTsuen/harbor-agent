import { describe, expect, it } from 'vitest'
import { scopeLabelOf, scopeToggleLabelOf, scopeWorkdirOf } from '../taskScope'

/* ══════════════════════════════════════════════════════════════
   任务中心「看哪些任务」

   背景：任务列表原来被硬过滤成"只看当前项目"（那条改动是为了让恢复清单与项目对齐），
   但「全局任务中心」（AG-028）的初衷是一眼看到所有项目跑过什么。
   所以改成**带开关**：默认只看当前项目，想全看就切一下。这里把那段判断钉住。
   ══════════════════════════════════════════════════════════════ */

describe('任务范围 / 传给主进程的 workdir', () => {
  it('只看当前项目 → 带项目目录', () => {
    expect(scopeWorkdirOf('project', 'E:/demo/site')).toBe('E:/demo/site')
  })

  it('★ 看全部 → 传空串（主进程就不过滤）', () => {
    expect(scopeWorkdirOf('all', 'E:/demo/site')).toBe('')
  })

  it('没有当前项目时（比如只在默认对话里）→ 空串，等于不过滤', () => {
    expect(scopeWorkdirOf('project', '')).toBe('')
  })
})

describe('任务范围 / 文案', () => {
  it('标题旁边那句：看全部时说「全部项目」', () => {
    expect(scopeLabelOf('all', 'site')).toBe('全部项目')
    expect(scopeLabelOf('project', 'site')).toBe('site')
  })

  it('没有项目名时退回「当前对话」', () => {
    expect(scopeLabelOf('project', '')).toBe('当前对话')
  })

  it('★ 按钮上写的是「点了会切到哪边」，不是当前状态', () => {
    expect(scopeToggleLabelOf('project')).toBe('看全部项目')
    expect(scopeToggleLabelOf('all')).toBe('只看当前项目')
  })
})
