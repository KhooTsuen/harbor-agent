import type { CodeBlock } from '@/types'
import { uid } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   模拟内容：代码块

   刻意写成**真实项目里会出现的样子**（带注释、带边界处理），
   而不是「示例 1 / 示例 2」那种模板味 —— 空壳内容一眼就能看出来。
   ══════════════════════════════════════════════════════════════ */

export function codeUseDebounce(): CodeBlock {
  return {
    id: uid('cb'),
    language: 'tsx',
    code: `import { useEffect, useState } from 'react'

/** 把一个会频繁变化的值「压一压」，只在停手 delay 毫秒后才更新 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])

  return debounced
}`,
  }
}

export function codeSplitHunks(): CodeBlock {
  return {
    id: uid('cb'),
    language: 'ts',
    code: `/** 把 unified diff 的文本切成 hunk，方便渲染成两栏 */
export function splitHunks(patch: string): string[][] {
  const hunks: string[][] = []
  let current: string[] | null = null

  for (const line of patch.split('\\n')) {
    if (line.startsWith('@@')) {
      current = [line]
      hunks.push(current)
      continue
    }
    if (current) current.push(line)
  }

  return hunks
}`,
  }
}

export function codeTokens(): CodeBlock {
  return {
    id: uid('cb'),
    language: 'css',
    code: `:root {
  /* 灰阶三级就够，级差小于 8 会糊成一片 */
  --bg-canvas: #101010;
  --bg-surface: #202020;
  --bg-raised: #2a2a2a;
  --border-hairline: rgb(255 255 255 / 0.08);
  --text-primary: #f8f8f8;
}`,
  }
}

export function codeTests(): CodeBlock {
  return {
    id: uid('cb'),
    language: 'ts',
    code: `import { describe, expect, it } from 'vitest'
import { relativeTime } from './utils'

describe('relativeTime', () => {
  const now = 1_700_000_000_000

  it('一分钟内显示「刚刚」', () => {
    expect(relativeTime(now - 30_000, now)).toBe('刚刚')
  })

  it('超过一小时换算成时', () => {
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 时')
  })

  it('未来时间不出现负数', () => {
    expect(relativeTime(now + 60_000, now)).toBe('刚刚')
  })
})`,
  }
}
