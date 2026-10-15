/**
 * 侧边栏入口（Phase 1c 第二步：真骨架）
 *
 * 第一步时这里只放一句 "Hello Harbor"（只验构建链路）；现在渲染真的 App。
 *
 * 样式在 `sidepanel.css` 里 —— 它 @import 主应用的两份 CSS，那是
 * 「视觉与主应用一致」的**唯一来源**（token 值不在这里重抄一遍）。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './sidepanel.css'
import { App } from './App'

const host = document.getElementById('root')
if (!host) {
  throw new Error('找不到 #root 容器，检查 index.html')
}

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
