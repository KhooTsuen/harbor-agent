import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   浏览器标签必须**常驻**，不许条件渲染

   用户报的 bug：Agent 用过浏览器之后，切到别的标签再切回来，网页重新加载了。

   根因是这一行：

     {activeRightTab === 'browser' ? <BrowserTab /> : null}

   切走 → 组件卸载 → `<webview>` 从 DOM 摘掉 → 底下 webContents 销毁
   → 切回来等于重新打开网页（滚动位置、填了一半的表单、SPA 状态全没）。
   终端早就绕过了这个坑（用 hidden 保住 PTY），浏览器这里漏了。

   修法是让浏览器层一直挂着，只换 `visible/invisible`（见 RightPanel 注释）。

   这一个测试守的就是**别改回去** —— 因为「没用到的标签别渲染」看着很像
   一条正确的性能优化，很容易被顺手「优化」掉。
   ══════════════════════════════════════════════════════════════ */

const FILE = join(process.cwd(), 'src/components/layout/RightPanel.tsx')

describe('右栏：浏览器标签常驻', () => {
  const src = readFileSync(FILE, 'utf8')
  /** 去掉换行，好让「同一表达式」的判断不被格式化打断 */
  const flat = src.replace(/\s+/g, ' ')

  it('BrowserTab 不在三元表达式里（否则会随标签卸载）', () => {
    expect(flat).not.toMatch(/activeRightTab === 'browser'\s*\?\s*<BrowserTab/)
    expect(flat).not.toMatch(/<BrowserTab\s*\/>\s*:\s*null/)
  })

  it('BrowserTab 仍然渲染（别在修的时候删掉）', () => {
    expect(flat).toContain('<BrowserTab />')
  })

  it('浏览器层用 absolute 铺在内容区上，切走时 invisible 而不是不渲染', () => {
    expect(flat).toContain('absolute inset-0 flex flex-col')
    expect(flat).toContain("'invisible'")
  })
})
