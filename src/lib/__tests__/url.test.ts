import { describe, expect, it } from 'vitest'
import { sameUrl } from '../url'

/* ══════════════════════════════════════════════════════════════
   ★ 真机抓到的：Agent 第二次 browse 同一个页面时给的是
   `https://example.com/`（第一次不带尾斜杠），严格比较 → 当成新地址
   → 开第二个标签、webview 重建、页面重新加载。
   ══════════════════════════════════════════════════════════════ */

describe('sameUrl', () => {
  it('末尾斜杠不算区别（真机踩的就是这个）', () => {
    expect(sameUrl('https://example.com', 'https://example.com/')).toBe(true)
    expect(sameUrl('https://example.com/a', 'https://example.com/a/')).toBe(true)
  })

  it('域名大小写、协议大小写不算区别', () => {
    expect(sameUrl('HTTPS://Example.com', 'https://example.com')).toBe(true)
  })

  it('带端口也一样', () => {
    expect(sameUrl('http://localhost:3000', 'http://localhost:3000/')).toBe(true)
  })

  it('路径不同就是不同页面', () => {
    expect(sameUrl('https://example.com/a', 'https://example.com/b')).toBe(false)
  })

  it('域名不同就是不同页面', () => {
    expect(sameUrl('https://example.com', 'https://example.org')).toBe(false)
  })

  it('查询串：相同就算同一个，不同就算不同', () => {
    expect(sameUrl('https://e.com/s?q=1', 'https://e.com/s?q=1')).toBe(true)
    expect(sameUrl('https://e.com/s?q=1', 'https://e.com/s?q=2')).toBe(false)
  })

  it('锚点不同算不同（同一页的不同位置）', () => {
    expect(sameUrl('https://e.com/a#x', 'https://e.com/a#y')).toBe(false)
    expect(sameUrl('https://e.com/a#x', 'https://e.com/a#x')).toBe(true)
  })

  it('path 大小写保留（路径本来就区分大小写）', () => {
    expect(sameUrl('https://e.com/Page', 'https://e.com/page')).toBe(false)
  })

  it('不是完整 URL 的（about:blank）退化成朴素比较', () => {
    expect(sameUrl('about:blank', 'about:blank')).toBe(true)
    expect(sameUrl('about:blank', 'about:blank/')).toBe(true)
    expect(sameUrl('about:blank', 'about:srcdoc')).toBe(false)
  })

  it('空值不当成同一个', () => {
    expect(sameUrl('', '')).toBe(true)
    expect(sameUrl('', 'https://example.com')).toBe(false)
  })
})
