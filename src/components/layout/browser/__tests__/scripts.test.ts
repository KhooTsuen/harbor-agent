import { describe, expect, it } from 'vitest'
import { clickScript, toIndex, typeScript } from '../scripts'

/* ══════════════════════════════════════════════════════════════
   浏览器操作的脚本生成

   这一组是**真机抓到的坑**补来的：`browse_click(0)` / `browse_type(0)`
   全都报「索引 -1 不存在」—— 因为代码里写的是 `Number(x) || -1`，
   而 `0` 是 falsy，索引 0 就被吃成了 -1。**点第一个元素直接失效。**
   ══════════════════════════════════════════════════════════════ */

describe('toIndex', () => {
  it('★ 索引 0 必须保留（0 是 falsy，不能掉进 || 的坑）', () => {
    expect(toIndex(0)).toBe(0)
    expect(toIndex('0')).toBe(0)
  })

  it('正常索引原样返回', () => {
    expect(toIndex(3)).toBe(3)
    expect(toIndex('12')).toBe(12)
  })

  it('缺失/非法一律 -1（脚本靠它报「索引不存在」）', () => {
    expect(toIndex(undefined)).toBe(-1)
    expect(toIndex(null)).toBe(-1)
    expect(toIndex('abc')).toBe(-1)
    expect(toIndex(-1)).toBe(-1)
    expect(toIndex(1.5)).toBe(-1)
    expect(toIndex(NaN)).toBe(-1)
  })
})

describe('脚本生成', () => {
  it('clickScript 用真实索引（含 0）', () => {
    expect(clickScript(0)).toContain('__walkInteractive()[0]')
    expect(clickScript(7)).toContain('__walkInteractive()[7]')
  })

  it('typeScript 用真实索引（含 0）', () => {
    expect(typeScript(0, 'x', false)).toContain('__walkInteractive()[0]')
  })

  it('★ 输入文字里的引号/换行不会把脚本写坏', () => {
    const nasty = 'he said "hi"\n\\ backslash ` tick ${danger}'
    const script = typeScript(1, nasty, false)
    /* 嵌进去的必须是合法的 JS 字符串字面量（JSON.stringify 的结果） */
    expect(script).toContain(JSON.stringify(nasty))
    /* 不能出现「裸」的换行（那会直接断掉语句） */
    expect(script.split('\n').some((line) => line.includes('he said'))).toBe(true)
  })

  it('pressEnter=false 不发键盘事件，true 才发', () => {
    expect(typeScript(0, 'x', false)).not.toContain('KeyboardEvent')
    expect(typeScript(0, 'x', true)).toContain("new KeyboardEvent('keydown'")
  })

  it('★ 打字用 native setter（React 受控组件才认）', () => {
    const script = typeScript(2, 'abc', false)
    expect(script).toContain('Object.getOwnPropertyDescriptor(proto, ')
    expect(script).toContain("dispatchEvent(new Event('input'")
  })
})
