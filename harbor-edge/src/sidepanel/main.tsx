/**
 * 侧边栏入口（Phase 1c 第一步：构建链路验证）
 *
 * 本文件**故意只放一句 "Hello Harbor"** —— 这一步只证明
 * 「Harbor 现有依赖（react / react-dom / tailwindcss / vite）能编出一个
 *   Edge 可加载的扩展页」，不做真正的侧边栏 UI（那是 1c 第二步）。
 *
 * 但样式类不是随便挑的：`bg-canvas` / `text-fg-primary` / `text-title`
 * 全都走**主 config 的 theme**，所以它们能出样式 = 证明「theme 继承 + CSS 变量」
 * 这条路是通的（这正是本步要验的核心）。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './sidepanel.css'

function App() {
  return (
    <div className="flex h-screen flex-col gap-3 bg-canvas p-4 text-fg-primary">
      <h1 className="text-title font-semibold">Hello Harbor</h1>
      <p className="text-meta text-fg-secondary">
        sidepanel build-chain probe（Phase 1c step 1）
      </p>
      {/* 语义色 + 圆角 + 间距各来一处，确保这几类 token 都真的编出来了 */}
      <div className="rounded-base border border-line-hairline bg-bg-raised p-3">
        <span className="text-meta text-accent">token probe</span>
      </div>
    </div>
  )
}

const host = document.getElementById('root')
if (host) {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
