import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clickLabelOf,
  describeReason,
  installActionLog,
  isBenignError,
  logAction,
  logError,
} from '@/lib/actionLog'

/* ══════════════════════════════════════════════════════════════
   动作日志（渲染层这一侧）

   用户要「把没预料到的事件也记下来，比如用户点了什么功能」——
   所以这一层是**兜底**：全量点击 + window 级异常，不靠逐个埋点。

   这里钉住四件事：
     ① 点到的元素能说出「是什么功能」（按钮文字 / aria-label / title，
        往上找最多 6 层）
     ② ★ **不记内容**：找不到标签的点击干脆不报（不然满屏「点了 div」，
        而且很容易把消息正文顺手记进去）
     ③ 连点只报一次
     ④ window 级 error / unhandledrejection 都会上报
     ⑤ ★ 已知的枆架噪声（Electron 的 `Invalid guestInstanceId`）不刷屏 ——
        但**只认那一条**，别的错一条都不能少
   ══════════════════════════════════════════════════════════════ */

interface Entry {
  kind: string
  name: string
  detail?: string
}
let actions: Entry[] = []
let errors: Array<{ where?: string; message?: string }> = []
let uninstall: (() => void) | null = null

beforeEach(() => {
  /* ★ 清空 DOM：不然 querySelector 会挑到上一条用例留下的按钮
     （去重状态是模块级的，撞上同一个标签就一条都不报了） */
  document.body.innerHTML = ''
  actions = []
  errors = []
  ;(window as unknown as { workbench: unknown }).workbench = {
    logAction: (entry: Entry) => actions.push(entry),
    logError: (entry: { where?: string; message?: string }) => errors.push(entry),
  }
  uninstall = installActionLog(document, window)
})

afterEach(() => {
  uninstall?.()
  uninstall = null
  delete (window as unknown as { workbench?: unknown }).workbench
})

/** 造一个能点的元素并点它 */
function click(html: string, selector: string): void {
  document.body.insertAdjacentHTML('beforeend', html)
  const el = document.querySelector(selector)
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('clickLabelOf', () => {
  it('优先用 aria-label', () => {
    expect(clickLabelOf(document.body)).toBe('')
    const el = document.createElement('button')
    el.setAttribute('aria-label', '上一版')
    document.body.appendChild(el)
    expect(clickLabelOf(el)).toBe('上一版')
  })

  it('没有 aria-label 就用按钮文字', () => {
    const el = document.createElement('button')
    el.textContent = '编辑'
    document.body.appendChild(el)
    expect(clickLabelOf(el)).toBe('编辑')
  })

  it('★ 点在按钮里的图标上，也要认出是那个按钮（往上找）', () => {
    const el = document.createElement('button')
    el.setAttribute('aria-label', '发送')
    el.innerHTML = '<span><svg></svg></span>'
    document.body.appendChild(el)
    expect(clickLabelOf(el.querySelector('svg'))).toBe('发送')
  })

  it('★ 普通 div 不上报（不然满屏「点了 div」，还容易把正文记进去）', () => {
    const el = document.createElement('div')
    el.textContent = '这是消息正文，不该进日志'
    document.body.appendChild(el)
    expect(clickLabelOf(el)).toBe('')
  })

  it('太长截断到 40 字', () => {
    const el = document.createElement('button')
    el.setAttribute('aria-label', 'x'.repeat(80))
    document.body.appendChild(el)
    expect(clickLabelOf(el).length).toBe(40)
  })
})

describe('installActionLog', () => {
  it('★ 点带标签的按钮 → 报一条 click（只报名字，不报内容）', () => {
    click('<button aria-label="上一版">‹</button>', 'button')
    expect(actions.length).toBe(1)
    expect(actions[0]?.kind).toBe('click')
    expect(actions[0]?.name).toBe('上一版')
    expect(actions[0]?.detail).toBeUndefined()
  })

  it('点没有标签的地方 → 一条都不报', () => {
    click('<div>正文</div>', 'div')
    expect(actions.length).toBe(0)
  })

  it('★ 连点只报一次（双击不算两件事）', () => {
    document.body.insertAdjacentHTML('beforeend', '<button aria-label="发送">发</button>')
    const el = document.querySelector('button')!
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(actions.length).toBe(1)
  })

  it('★ 未捕获异常上报（以前只 console.error，用户报错时日志里查不到）', () => {
    const error = new Error('something exploded')
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toContain('something exploded')
  })

  it('★ 未处理的 Promise 拒绝也上报', () => {
    const event = new Event('unhandledrejection') as Event & { reason?: unknown }
    event.reason = new Error('boom')
    window.dispatchEvent(event)
    expect(errors.length).toBe(1)
    expect(errors[0]?.where).toBe('unhandledrejection')
  })

  /* ── Electron 的 webview 拆卸噪声（2026-09-30） ────────────────
     `<webview>` 摘出 DOM 时 Electron 内部会抛 `Invalid guestInstanceId: N`。
     真机上它把当天日志刷了 150+ 行，把真正的错埋了。
     判据：**只认这一条**，别的错一个字都不能少。 */
  it('★ 已知噪声（Invalid guestInstanceId）不刷屏：同一个形状只报第一条', () => {
    for (const id of [2, 3, 4, 5]) {
      const error = new Error(`Invalid guestInstanceId: ${id}`)
      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    }
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toContain('Invalid guestInstanceId')
  })

  it('★ 别的错一条都不能少（过滤只认那一条，不误伤）', () => {
    const before = errors.length
    for (const message of [
      'Invalid guestInstanceId 说的是别的意思', // 少个冒号，不是它
      'Error: Invalid guestInstanceId: 9', // 第一行不是它（前面有前缀）
      'Cannot read properties of undefined',
    ]) {
      const error = new Error(message)
      window.dispatchEvent(new ErrorEvent('error', { error, message }))
    }
    expect(errors.length).toBe(before + 3)
  })

  it('isBenignError 只认整行就是它的那种', () => {
    expect(isBenignError('Invalid guestInstanceId: 7')).toBe(true)
    expect(
      isBenignError('Invalid guestInstanceId: 7\n    at WebViewElement.disconnectedCallback'),
    ).toBe(true)
    expect(isBenignError('Invalid guestInstanceId')).toBe(false)
    expect(isBenignError('别的错 Invalid guestInstanceId: 7')).toBe(false)
  })

  it('卸载之后不再报（测试里要能收干净）', () => {
    uninstall?.()
    uninstall = null
    click('<button aria-label="编辑">编辑</button>', 'button')
    expect(actions.length).toBe(0)
  })
})

describe('主动上报', () => {
  it('logAction 带 detail（功能性埋点用）', () => {
    logAction('切提问版本', 'v1 → v0')
    expect(actions[0]?.name).toBe('切提问版本')
    expect(actions[0]?.detail).toBe('v1 → v0')
  })

  it('logError 把 stack 一起带上（截断 500 字）', () => {
    logError('ErrorBoundary', new Error('渲染炸了'))
    expect(errors[0]?.where).toBe('ErrorBoundary')
    expect(errors[0]?.message).toContain('渲染炸了')
  })

  it('describeReason 能吃非 Error（Promise 里 reject 字符串很常见）', () => {
    expect(describeReason('字符串原因')).toBe('字符串原因')
    expect(describeReason({ code: 500 })).toContain('500')
  })

  it('没有桥（浏览器预览模式）也不炸', () => {
    delete (window as unknown as { workbench?: unknown }).workbench
    expect(() => logAction('随便点点')).not.toThrow()
    expect(() => logError('x', new Error('y'))).not.toThrow()
  })
})
