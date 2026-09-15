import { describe, expect, it } from 'vitest'
import { detectIntent, deriveTitle } from '@/lib/mock/ai'

describe('mock 意图识别', () => {
  it('识别代码意图', () => {
    expect(detectIntent('帮我写一个组件')).toBe('code')
    expect(detectIntent('新建一个函数')).toBe('code')
  })

  it('识别 diff / 修复意图', () => {
    expect(detectIntent('这里有个 bug')).toBe('diff')
    expect(detectIntent('修复一下报错')).toBe('diff')
  })

  it('识别终端意图', () => {
    expect(detectIntent('跑一下 npm run dev')).toBe('terminal')
    expect(detectIntent('git status 看看')).toBe('terminal')
  })

  it('识别解释意图', () => {
    expect(detectIntent('解释一下这段代码')).toBe('explain')
  })

  it('识别测试意图（优先于解释）', () => {
    expect(detectIntent('补几个测试用例')).toBe('test')
  })

  it('默认回退', () => {
    expect(detectIntent('你好')).toBe('fallback')
  })
})

describe('deriveTitle', () => {
  it('带前缀的短标题', () => {
    expect(deriveTitle('修一下那个报错')).toBe('修复：修一下那个报错')
  })

  it('超长标题截断', () => {
    const title = deriveTitle('这是一个非常非常非常非常非常非常长的输入内容')
    expect(title.length).toBeLessThanOrEqual(25)
  })

  it('空输入回退', () => {
    expect(deriveTitle('   ')).toBe('新对话')
  })
})
