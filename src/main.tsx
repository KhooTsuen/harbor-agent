/* 必须是第一个 import：它要在任何 store 创建之前完成 localStorage 迁移 */
import './lib/migrateStorage'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 容器，检查 index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
