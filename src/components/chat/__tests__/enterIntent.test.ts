import { describe, expect, it } from 'vitest'
import { enterIntent, type EnterKeyInfo } from '../composer/enterIntent'

/* ══════════════════════════════════════════════════════════════
   P2 #13：中文输入保护 + 发送习惯

   这些用例钉的是**判据**，不是真实输入法。真实输入法行为
   （组词时 Chrome 到底给不给 isComposing / 229）需要用户在真机上试，
   这里只保证：「一旦浏览器那样报事件，我们一定不会误发」。
   ══════════════════════════════════════════════════════════════ */

function info(patch: Partial<EnterKeyInfo> = {}): EnterKeyInfo {
  return {
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 13,
    ...patch,
  }
}

describe('P2 #13 中文输入保护', () => {
  it('组词中按 Enter 不发送（isComposing）', () => {
    expect(enterIntent(info({ isComposing: true }), true)).toBe('ignore')
  })

  it('输入法的 229 回车也不发送 —— 有些 IME 在组词结束后才补这一下', () => {
    expect(enterIntent(info({ keyCode: 229 }), true)).toBe('ignore')
  })

  it('组词时即使按了 Ctrl+Enter 也不发送', () => {
    expect(enterIntent(info({ isComposing: true, ctrlKey: true }), false)).toBe('ignore')
  })

  it('组词结束后普通 Enter 正常发送', () => {
    expect(enterIntent(info(), true)).toBe('send')
  })

  it('Shift+Enter 永远换行，不是发送', () => {
    expect(enterIntent(info({ shiftKey: true }), true)).toBe('pass')
    expect(enterIntent(info({ shiftKey: true }), false)).toBe('pass')
  })

  it('Alt+Enter 也不发送（避免和系统快捷键冲突）', () => {
    expect(enterIntent(info({ altKey: true }), true)).toBe('pass')
  })

  it('习惯是 Ctrl+Enter 发送时，光按 Enter 必须换行', () => {
    expect(enterIntent(info(), false)).toBe('pass')
    expect(enterIntent(info({ ctrlKey: true }), false)).toBe('send')
    expect(enterIntent(info({ metaKey: true }), false)).toBe('send')
  })

  it('不是 Enter 键的一律交给浏览器（光标移动 / Esc / Tab）', () => {
    expect(enterIntent(info({ key: 'Escape' }), true)).toBe('pass')
    expect(enterIntent(info({ key: 'Tab' }), true)).toBe('pass')
    expect(enterIntent(info({ key: 'a' }), true)).toBe('pass')
  })
})
