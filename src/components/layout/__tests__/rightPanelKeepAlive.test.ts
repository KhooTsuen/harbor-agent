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
const APP_FILE = join(process.cwd(), 'src/App.tsx')
const HOST_FILE = join(process.cwd(), 'src/components/layout/RightPanelHost.tsx')

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

/* ══════════════════════════════════════════════════════════════
   同一类问题的另一半：折叠整个右栏

   原来是 `{rightPanelVisible ? <RightPanel /> : null}` —— 点 × 折叠时
   整个右栏卸载，里面的 <webview> 一样被销毁。现在这段搬进了
   RightPanelHost，折叠只加 `hidden`。

   （附带好处：`useBrowseBridge` 挂在 RightPanel 上，折叠着的时候
     Agent 的浏览请求也有人接 —— 以前是没人接，等到超时报错。）
   ══════════════════════════════════════════════════════════════ */

describe('右栏：折叠也不卸载', () => {
  const host = readFileSync(HOST_FILE, 'utf8')
  const flatHost = host.replace(/\s+/g, ' ')

  it('RightPanel 不在条件渲染里', () => {
    const line = host.split('\n').find((l) => l.includes('<RightPanel'))
    expect(line, '找不到 <RightPanel />').toBeDefined()
    expect(line).not.toContain('?')
    expect(flatHost).not.toMatch(/visible\s*\?\s*<RightPanel/)
  })

  it('折叠是加 hidden，不是不渲染', () => {
    expect(flatHost).toContain("!visible && 'hidden'")
  })

  it('App 用的是这个 host（别把面板又内联回去）', () => {
    const app = readFileSync(APP_FILE, 'utf8').replace(/\s+/g, ' ')
    expect(app).toContain('<RightPanelHost')
    expect(app).not.toContain('<RightPanel />')
  })
})
