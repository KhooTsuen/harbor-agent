import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   终端只在底栏（用户要的）

   原来左右两处都能开终端：右栏一个标签、底栏一个标签。同一个东西两个入口，
   用户不知道该用哪个。现在收敛到**底栏**（Ctrl+J）。

   这是源码守卫而不是渲染测试：要断言的是「清单里没有它了」，
   渲染一遍还得 mock 一堆依赖，反而看不清在防什么。
   ══════════════════════════════════════════════════════════════ */

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

describe('终端只在底栏', () => {
  it('★ 右栏的标签清单里没有「终端」', () => {
    const src = read('src/components/layout/RightPanel.tsx')
    expect(src).not.toContain("id: 'terminal'")
    /* 也别再引那个终端组件 —— 留着的话下次有人顺手加回来 */
    expect(src).not.toContain("from './Terminal'")
  })

  it('★ 右栏标签类型里没有 terminal（类型即文档）', () => {
    const types = read('src/types/index.ts')
    const line = types.split('\n').find((l) => l.includes('export type RightTab')) ?? ''
    expect(line).not.toContain('terminal')
  })

  it('★ 命令面板的「打开终端」开的是底栏，不是右栏', () => {
    const src = read('src/components/layout/CommandPalette.tsx')
    expect(src).toContain("openBottomPanel('terminal')")
    expect(src).not.toContain("setActiveRightTab('terminal')")
  })

  it('★ 底栏两个视图还在（日志 / 终端）', () => {
    const src = read('src/components/layout/BottomPanel.tsx')
    expect(src).toContain("setView('terminal')")
    expect(src).toContain("setView('log')")
  })

  it('★ 老配置里存的 lastRightTab=terminal 会被丢掉（回落到默认）', () => {
    const src = read('src/stores/useSettingsStore.ts')
    expect(src).not.toContain("s.lastRightTab === 'terminal'")
  })
})
