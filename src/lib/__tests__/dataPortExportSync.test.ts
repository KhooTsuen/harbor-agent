import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   内核脱敏表 ↔ 渲染层脱敏表：那份「逐字一致」的契约

   背景（2026-10-06 核对）：`dataPortExport.ts` 的注释里**三处**写着
   「自检组 69 盯着这行 / 按这份清单断言」—— 而 `scripts/selftest/groups/`
   里**没有 69 那一组**：这条契约其实没人盯（注释写了个不存在的守卫）。

   为什么不是合并成一份实现：两边分属两个世界（内核是 CommonJS + 带
   「已知真实密钥」的精确替换，渲染层过 Vite），硬合会把内核拖进打包链。
   所以这里落成**一份测试** —— 谁改了一边没改另一边，立刻红。
   （教训记一条：注释里写「某某在盯着」之前，先确认那个某某真的存在。）
   ══════════════════════════════════════════════════════════════ */

const renderer = readFileSync(join(process.cwd(), 'src', 'lib', 'dataPortExport.ts'), 'utf8')
const kernel = readFileSync(join(process.cwd(), 'electron', 'core', 'redact.cjs'), 'utf8')

/** 比正则体时把空白折掉：两边换行位置不同，但那不影响正则的含义 */
const flatten = (text: string): string => text.replace(/\s+/g, '')

/** 取 `const X =` 后面那个正则字面量的**体**（不含首尾斜杠与 flags） */
function bodyAfter(source: string, marker: string): string {
  const at = source.indexOf(marker)
  expect(at, `找不到 ${marker}`).toBeGreaterThan(-1)
  const rest = source.slice(at + marker.length)
  const start = rest.indexOf('/')
  const end = rest.indexOf('/i', start)
  expect(start, `${marker} 后面没跟正则`).toBeGreaterThan(-1)
  expect(end, `${marker} 的正则不是 /i 结尾`).toBeGreaterThan(start)
  return flatten(rest.slice(start + 1, end))
}

describe('脱敏表：内核与渲染层不许各说各话', () => {
  it('★ 键名口径（SECRET_KEY）逐字一致', () => {
    expect(bodyAfter(renderer, 'const SECRET_KEY =')).toBe(bodyAfter(kernel, 'const SECRET_KEY ='))
  })

  it('★ 自由文本的键名候选必须是内核 PATTERNS 的子集（渲染层不许自己发明）', () => {
    const start = renderer.indexOf('(?:')
    const end = renderer.indexOf(')["\']?', start)
    /* 这段取不出来就说明源码结构变了 —— 那时要人来改测试，不是静默放过 */
    expect(start, '找不到自由文本规则的候选组').toBeGreaterThan(-1)
    expect(end, '找不到候选组的结尾').toBeGreaterThan(start)

    const alternatives = renderer
      .slice(start + 3, end)
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean)
    expect(alternatives.length, '候选取出来太少（结构变了？）').toBeGreaterThan(8)

    const kernelFlat = flatten(kernel)
    for (const alternative of alternatives) expect(kernelFlat).toContain(alternative)
  })

  it('★ 内核认的那些厂商前缀，渲染层一个都不能少', () => {
    /* String.raw：直接比对**源码里那几个字符**，不用在测试里再转义一遍（转错会假红） */
    for (const marker of [
      String.raw`sk-`,
      String.raw`gh[pousr]_`,
      String.raw`github_pat_`,
      String.raw`AIza`,
      String.raw`xox[baprs]-`,
      String.raw`AKIA`,
      String.raw`hf_`,
      String.raw`eyJ`,
      String.raw`BEGIN [A-Z ]*PRIVATE KEY`,
      String.raw`https?:\/\/[^\s/@:]+`,
    ]) {
      expect(renderer, `渲染层少了「${marker}」这一条`).toContain(marker)
    }
  })

  it('导出包的键清单本身是干净的（没重复、含必需项）', () => {
    const at = renderer.indexOf('export const EXPORT_KEYS')
    /* 数组起点要取 `=` 之后的 `[` —— 否则会抓到 `readonly string[]` 的 `]`（踩过） */
    const start = renderer.indexOf('[', renderer.indexOf('=', at))
    const end = renderer.indexOf(']', start)
    expect(start, '找不到键清单').toBeGreaterThan(-1)
    const declared = [...renderer.slice(start, end).matchAll(/'([A-Za-z]+)'/g)].map((hit) => hit[1])

    expect(declared.length, '键清单取不出来（源码结构变了？）').toBeGreaterThan(5)
    expect(new Set(declared).size).toBe(declared.length)
    for (const key of ['app', 'sessions', 'tasks', 'memory', 'config']) {
      expect(declared).toContain(key)
    }
  })
})
