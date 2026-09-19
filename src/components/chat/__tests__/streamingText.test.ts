import { describe, expect, it } from 'vitest'
import { splitLine } from '@/components/chat/StreamingText'

/* ══════════════════════════════════════════════════════════════
   AG-023 流式正文的标记染色

   只测一件事：行首标记被正确识别成「标记 + 内容」，内容部分**原样**
   返回（不丢字、不改字）。染色只是视觉，不改数据。
   ══════════════════════════════════════════════════════════════ */

describe('StreamingText splitLine', () => {
  it('标题标记', () => {
    expect(splitLine('## 标题')).toEqual({ marker: '## ', rest: '标题' })
    expect(splitLine('### 三级')).toEqual({ marker: '### ', rest: '三级' })
  })

  it('无序列表标记', () => {
    expect(splitLine('- 甲')).toEqual({ marker: '- ', rest: '甲' })
    expect(splitLine('* 乙')).toEqual({ marker: '* ', rest: '乙' })
    expect(splitLine('+ 丙')).toEqual({ marker: '+ ', rest: '丙' })
  })

  it('有序列表标记', () => {
    expect(splitLine('1. 第一')).toEqual({ marker: '1. ', rest: '第一' })
    expect(splitLine('12) 第十二')).toEqual({ marker: '12) ', rest: '第十二' })
  })

  it('引用标记', () => {
    expect(splitLine('> 引一句')).toEqual({ marker: '> ', rest: '引一句' })
  })

  it('围栏', () => {
    expect(splitLine('```ts')).toEqual({ marker: '```ts', rest: '' })
    expect(splitLine('```')).toEqual({ marker: '```', rest: '' })
  })

  it('普通行没有标记（内容原样）', () => {
    expect(splitLine('这是普通文字')).toEqual({ marker: '', rest: '这是普通文字' })
    expect(splitLine('')).toEqual({ marker: '', rest: '' })
  })

  it('★ 缩进的标记也能识别（嵌套列表）', () => {
    expect(splitLine('  - 嵌套')).toEqual({ marker: '  - ', rest: '嵌套' })
  })

  it('★ 内容里的 - 和 # 不算标记（只有行首才算）', () => {
    expect(splitLine('甲-乙')).toEqual({ marker: '', rest: '甲-乙' })
    expect(splitLine('甲 # 乙')).toEqual({ marker: '', rest: '甲 # 乙' })
  })
})
