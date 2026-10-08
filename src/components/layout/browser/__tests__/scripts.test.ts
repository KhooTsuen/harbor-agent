import { describe, expect, it } from 'vitest'
import { SNAPSHOT_SCRIPT, clickPointScript, focusScript, toIndex } from '../scripts'

/* ══════════════════════════════════════════════════════════════
   浏览器操作的脚本生成

   这一组是**真机抓到的坑**补来的：`browse_click(0)` / `browse_type(0)`
   全都报「索引 -1 不存在」—— 因为代码里写的是 `Number(x) || -1`，
   而 `0` 是 falsy，索引 0 就被吃成了 -1。**点第一个元素直接失效。**

   2026-10-09 起：脚本只**算落点 / 聚焦校验**，真事件（sendInputEvent /
   insertText）由主进程派发 —— 所以这里验的是「校验 + 返回坐标/状态」。
   ══════════════════════════════════════════════════════════════ */

/** 元素身份记录用的键（和 scriptParts.ts 的 SNAP_KEY 一致） */
const SNAP_KEY = '__harborSnapEls'

/** 跑一遍 snapshot：既产出清单，也把元素对象记到 window 上（click/type 靠它核对身份） */
const snap = (): void => {
  eval(SNAPSHOT_SCRIPT)
}

/** 清掉身份记录（验「没先 browse_elements 就操作」时用） */
const clearSnap = (): void => {
  delete (window as unknown as Record<string, unknown>)[SNAP_KEY]
}

/**
 * jsdom 里 getBoundingClientRect 全是 0，会被脚本的「零尺寸」过滤掉 —— 打个桩。
 */
const stubRect = (
  r = { left: 0, top: 0, width: 100, height: 30, right: 100, bottom: 30 },
): void => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => r,
  })
}

/** jsdom 没实现 elementFromPoint —— 打桩决定「落点上真正接事件的是谁」 */
const stubPoint = (el: Element | null): void => {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => el,
  })
}

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
  it('clickPointScript 用真实索引（含 0）', () => {
    expect(clickPointScript(0)).toContain('__walkInteractive()[0]')
    expect(clickPointScript(7)).toContain('__walkInteractive()[7]')
  })

  it('focusScript 用真实索引（含 0）', () => {
    expect(focusScript(0)).toContain('__walkInteractive()[0]')
  })

  it('★ 脚本只回坐标/状态，不自己点、不自己写字（真事件在主进程）', () => {
    /* 不该再出现合成派发 */
    expect(clickPointScript(0)).not.toContain('target.click()')
    expect(focusScript(0)).not.toContain('dispatchEvent')
    expect(focusScript(0)).not.toContain('setter.call')
  })
})

describe('密码框闸门', () => {
  /*
   * 用户要的是「明确授权就放行」——「明确」的落地方式就是一个确认弹窗。
   * 所以脚本默认**不聚焦也不放行**密码框，带上 authorized 才继续。
   */
  it('★ 没授权时不放行，返回 needsConfirm', () => {
    const script = focusScript(0, false)
    expect(script).toContain('var authorized = false')
    expect(script).toContain('needsConfirm: true')
  })

  it('★ 授权后才继续', () => {
    expect(focusScript(0, true)).toContain('var authorized = true')
  })

  it('密码框靠 type=password 认出来，并把 password 标志回给主进程', () => {
    const script = focusScript(0, true)
    expect(script).toContain("target.type === 'password'")
    expect(script).toContain('password: isPassword')
  })
})

describe('快照不泄露密码', () => {
  /*
   * 真机抓过：`browse_elements` 读 `el.value`，把密码框里的密码
   * 原样写进了元素清单 → 进了模型上下文、工具结果和会话。
   * 这一组是**真在 jsdom 里跑一遍脚本**，不是只查字符串。
   */
  it('★ 密码框只回「已填/未填」，不回具体值', () => {
    document.body.innerHTML =
      '<input type="text" value="alice">' +
      '<input type="password" value="MyTestPass123">' +
      '<input type="password" placeholder="Password">'
    stubRect()

    const result = eval(SNAPSHOT_SCRIPT) as { items?: Array<{ text?: string }> } | undefined
    const joined = (result?.items ?? []).map((i) => i.text ?? '').join(' | ')

    expect(joined).not.toContain('MyTestPass123')
    expect(joined).toContain('已填')
    /* 普通输入框的值照旧能读到（别因噎废食） */
    expect(joined).toContain('alice')
  })
})

describe('写入前校验（学 dsh-browser 的 typing-actionability）', () => {
  /*
   * 真机教训：往 readonly/disabled 框里塞值，工具却回「已输入」，而框里一直是
   * 空的 —— 回报是假的，而且假得很有说服力（模型会以为填好了，接着提交一个空表单）。
   * 这一组是**真在 jsdom 里跑一遍脚本**（不是只查字符串）。
   */
  const run = (index: number): { ok?: boolean; error?: string; into?: string } =>
    eval(focusScript(index)) as { ok?: boolean; error?: string; into?: string }

  it('★ 只读框：拒绝，且聚焦都不做', () => {
    document.body.innerHTML = '<input type="text" readonly>'
    stubRect()
    snap()
    const r = run(0)
    expect(r?.ok).toBe(false)
    expect(String(r?.error)).toContain('readonly')
  })

  it('★ 禁用框：理由来自元素自己（不是「焦点没落上」）', () => {
    document.body.innerHTML = '<input type="text" disabled>'
    stubRect()
    snap()
    const r = run(0)
    expect(r?.ok).toBe(false)
    expect(String(r?.error)).toContain('disabled')
  })

  it('可编辑框：聚焦成功并回报 into（真文字由主进程插）', () => {
    document.body.innerHTML = '<input type="text">'
    stubRect()
    snap()
    const r = run(0)
    expect(r?.ok).toBe(true)
    expect(r?.into).toBe('input')
  })
})

describe('点击落点核对（学 dsh-browser 的 click-point-and-interception）', () => {
  /*
   * 合成点击无视遮挡：点到遮罩层上，报告照样写「已点击」。这一组验的是
   * 「落点由页面自己算 + elementFromPoint 核对」这套拒绝逻辑（真跑脚本）。
   */
  it('★ 落点被遮挡：默认拒绝，force 才放行（并回报 obstructed + 坐标）', () => {
    document.body.innerHTML = '<button id="go">go</button>'
    stubRect()
    snap()
    const other = document.createElement('div')
    document.body.appendChild(other)
    stubPoint(other)
    const r1 = eval(clickPointScript(0, false)) as { ok?: boolean; error?: string }
    expect(r1.ok).toBe(false)
    expect(String(r1.error)).toContain('挡住')
    const r2 = eval(clickPointScript(0, true)) as {
      ok?: boolean
      obstructed?: boolean
      x?: number
      y?: number
    }
    expect(r2.ok).toBe(true)
    expect(r2.obstructed).toBe(true)
    expect(typeof r2.x).toBe('number')
    expect(typeof r2.y).toBe('number')
  })

  it('落点是目标自己：放行，obstructed=false', () => {
    document.body.innerHTML = '<button id="go">go</button>'
    stubRect()
    snap()
    stubPoint(document.getElementById('go'))
    const r = eval(clickPointScript(0, false)) as { ok?: boolean; obstructed?: boolean }
    expect(r.ok).toBe(true)
    expect(r.obstructed).toBe(false)
  })

  it('★ 落点在视口外：一律拒绝（force 也不放行）', () => {
    document.body.innerHTML = '<button>go</button>'
    stubRect()
    snap()
    /* 半滚出屏幕：rect 与视口仍有交集（不被 walk 过滤），但中心点在视口左侧外 */
    stubRect({ left: -300, top: 10, width: 400, height: 20, right: 100, bottom: 30 })
    const r = eval(clickPointScript(0, true)) as { ok?: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('视口外')
  })
})

describe('索引漂移 / 跨页（学 dsh-browser 的「ref 属于页面」）', () => {
  /*
   * 页面变了（元素对象被换掉、或整个文档换了），旧索引就可能指到**别的**元素上，
   * 而点击会静默点到它、工具还回报「已点击」——最坏的一种假成功。
   * 判据是**对象身份**：同一元素即使文字变了也还是同一个对象，不会误报。
   */
  it('★ 页面变了（元素被换掉）：拒绝，让模型重新读', () => {
    document.body.innerHTML = '<button>旧</button>'
    stubRect()
    snap()
    document.body.innerHTML = '<button>新</button>'
    stubPoint(document.querySelector('button'))
    const r = eval(clickPointScript(0, false)) as { ok?: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('页面变了')
  })

  it('★ 没先读元素就点：拒绝（先 browse_elements）', () => {
    document.body.innerHTML = '<button>go</button>'
    stubRect()
    clearSnap()
    const r = eval(clickPointScript(0, false)) as { ok?: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('browse_elements')
  })

  it('★ 打字前页面变了：拒绝', () => {
    document.body.innerHTML = '<input type="text">'
    stubRect()
    snap()
    document.body.innerHTML = '<input type="text">'
    const r = eval(focusScript(0)) as { ok?: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('页面变了')
  })

  it('同页元素没换：照点（别误伤）', () => {
    document.body.innerHTML = '<button id="go">go</button>'
    stubRect()
    snap()
    stubPoint(document.getElementById('go'))
    const r = eval(clickPointScript(0, false)) as { ok?: boolean }
    expect(r.ok).toBe(true)
  })
})
