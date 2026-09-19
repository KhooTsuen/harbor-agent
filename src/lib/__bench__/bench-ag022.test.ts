import { describe, expect, it } from 'vitest'
import { splitTokens } from '@/components/chat/codeblock/lines'
import { tokenize } from '@/lib/highlight'

/* ══════════════════════════════════════════════════════════════
   AG-022 baseline：流式代码块的高亮代价

   代码块是流式里最"贵"的块 —— 它每来一行就要重跑一遍高亮。
   而且 tokenizer 是**对整个字符串**做的，所以一个 N 行的代码块，
   流式写完要花 O(N²)。

   这里量两件事：
     · splitTokens 单独一次多少钱（随行数怎么涨）
     · 一次完整流式（逐行追加）累计多少钱
   ══════════════════════════════════════════════════════════════ */

/** 造一段 TS 代码，行数可控，且包含多行字符串/块注释这类"有状态"的东西 */
function makeCode(lines: number): string {
  const out: string[] = ['import { readFile } from "node:fs/promises"', '']
  let i = 0
  while (out.length < lines) {
    if (i % 9 === 0) out.push(`/** 第 ${i} 段说明 —— 这是块注释，会跨行 */`)
    else if (i % 9 === 1) out.push(` * 它让 tokenizer 必须带着状态往下走`)
    else if (i % 9 === 2) out.push(' */')
    else if (i % 7 === 3) out.push(`const text${i} = \`模板\n字符串${i}\``)
    else out.push(`const value${i} = await readFile("f${i}.ts", "utf8") // 注释 ${i}`)
    i += 1
  }
  return out.join('\n')
}

function costOnce(code: string) {
  let t = 0
  for (let k = 0; k < 15; k += 1) {
    const t0 = performance.now()
    splitTokens(code, 'typescript')
    t += performance.now() - t0
  }
  return t / 15
}

describe('AG-022 baseline：代码块高亮', () => {
  it('单次高亮随行数怎么涨', () => {
    const rows: string[] = []
    for (const n of [20, 50, 100, 200, 400]) {
      const ms = costOnce(makeCode(n))
      rows.push(`${String(n).padStart(4)} 行 → ${ms.toFixed(2)} ms`)
    }
    console.info('单次 splitTokens：' + rows.join(' · '))

    /*
     * 守卫：高亮是线性增长（400 行 / 100 行 ≈ 4 倍），不能爆炸。
     * 阈值放到 15 倍 —— jsdom 里的计时波动很大，这条要防的是「变成 O(n²)」，
     * 不是「慢了 10%」。精确数字看上面打印的那行。
     */
    const a = costOnce(makeCode(100))
    const b = costOnce(makeCode(400))
    expect(b / a).toBeLessThan(15)
  })

  it('★ 一次完整流式（逐行追加）累计多少钱', () => {
    for (const n of [50, 100, 200]) {
      const full = makeCode(n)
      const lines = full.split('\n')
      let t = 0
      /* 模拟流式：每次多一行就重跑一遍（这就是现在的行为） */
      for (let i = 1; i <= lines.length; i += 1) {
        const partial = lines.slice(0, i).join('\n')
        const t0 = performance.now()
        splitTokens(partial, 'typescript')
        t += performance.now() - t0
      }
      console.info(`${String(n).padStart(4)} 行代码块流式写完 → 累计 ${t.toFixed(0)} ms`)
    }
  })

  it('tokenize 是纯函数吗（能不能缓存）', () => {
    const code = makeCode(30)
    const a = tokenize(code, 'typescript')
    const b = tokenize(code, 'typescript')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
