/* 必须是第一个 import：它要在任何 store 创建之前完成 localStorage 迁移 */
import './lib/migrateStorage'
import { installActionLog } from '@/lib/actionLog'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

/*
 * ★ 兜底日志要在 React 挂载**之前**装上：装晚了会漏掉启动阶段的错误
 *   （全量点击 + window 级 error/unhandledrejection，见 lib/actionLog.ts）。
 */
installActionLog()

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 容器，检查 index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
