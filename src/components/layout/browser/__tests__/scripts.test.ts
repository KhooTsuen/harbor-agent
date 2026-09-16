import { describe, expect, it } from 'vitest'
import { SNAPSHOT_SCRIPT, clickScript, toIndex, typeScript } from '../scripts'

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

describe('密码框闸门', () => {
  /*
   * 用户要的是「明确授权就放行」——「明确」的落地方式就是一个确认弹窗。
   * 所以脚本默认**不填**密码，带上 authorized 才填。
   */
  it('★ 没授权时不填，返回 needsConfirm', () => {
    const script = typeScript(0, 'secret123', false, false)
    expect(script).toContain('var authorized = false')
    expect(script).toContain('needsConfirm: true')
  })

  it('★ 授权后才真的填', () => {
    expect(typeScript(0, 'secret123', false, true)).toContain('var authorized = true')
  })

  it('★ 密码不回显（返回值会进模型上下文和对话记录）', () => {
    const script = typeScript(0, 'secret123', false, true)
    expect(script).toContain('isPassword ?')
    expect(script).toContain('已隐藏')
  })

  it('密码框靠 type=password 认出来', () => {
    expect(typeScript(0, 'x', false, true)).toContain("target.type === 'password'")
  })
})

describe('快照不泄露密码', () => {
  /*
   * 真机抳到过：`browse_elements` 读 `el.value`，把密码框里的密码
   * 原样写进了元素清单 → 进了模型上下文、工具结果和会话。
   * 这一组是**真在 jsdom 里跑一遍脚本**，不是只查字符串。
   */
  it('★ 密码框只回「已填/未填」，不回具体值', () => {
    document.body.innerHTML =
      '<input type="text" value="alice">' +
      '<input type="password" value="MyTestPass123">' +
      '<input type="password" placeholder="Password">'

    /* jsdom 里 getBoundingClientRect 全是 0，会被脚本的「零尺寸」过滤掉 —— 打个桩 */
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 100, height: 30, right: 100, bottom: 30 }),
    })

    const result = eval(SNAPSHOT_SCRIPT) as { items?: Array<{ text?: string }> } | undefined
    const joined = (result?.items ?? []).map((i) => i.text ?? '').join(' | ')

    expect(joined).not.toContain('MyTestPass123')
    expect(joined).toContain('已填')
    /* 普通输入框的值照旧能读到（别因噎废食） */
    expect(joined).toContain('alice')
  })
})
