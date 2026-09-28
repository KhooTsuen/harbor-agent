/**
 * 开发启动器
 *
 * 同时起两样东西：
 *   1. Vite 开发服务器（渲染层，热更新）
 *   2. Electron（主进程，加载上面那个地址）
 *
 * 为什么不装 concurrently / wait-on：
 *   只需要管好「等端口通 → 起 electron → 任一退出就都退出」这三件事，
 *   为它多两个依赖不值。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.DEV_PORT ?? 5273)
const URL = `http://localhost:${PORT}`
/* 渲染层调试端口（Chromium CDP）：默认 9222，只监听本机。
   为什么要有：改 UI 时能真断点、能读 React 里的状态，而不是只能靠探针打印。
   探针（tmp/perf/）早就用同一个开关驱真机包了，这里只是把开发模式也接上。 */
const DEBUG_PORT = Number(process.env.DEV_DEBUG_PORT ?? 9222)
/* 主进程调试端口：**只在显式设置时才开** ——
   因为它会暂停等调试器接入（--inspect 不暂停，但一旦接入就停），不想给你意外。 */
const INSPECT_PORT = process.env.DEV_INSPECT_PORT ? Number(process.env.DEV_INSPECT_PORT) : null

const ELECTRON_BIN = resolve(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
)

if (!existsSync(ELECTRON_BIN)) {
  console.error('找不到 Electron 二进制：', ELECTRON_BIN)
  console.error('先跑一次 npm install')
  process.exit(1)
}

const children = []

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  process.exit(code)
}

/* ── 1. Vite ─────────────────────────────────────────────── */

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
children.push(vite)

let viteReady = false
vite.stdout.on('data', (buf) => {
  const text = buf.toString()
  process.stdout.write(`[vite] ${text}`)
  if (text.includes('ready in') || text.includes('Local:')) viteReady = true
})
vite.stderr.on('data', (buf) => process.stderr.write(`[vite] ${buf}`))
vite.on('exit', (code) => {
  console.log(`[vite] 退出，代码 ${code}`)
  shutdown(code ?? 0)
})

/* ── 2. 等端口通 ─────────────────────────────────────────── */

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (viteReady) return true
    try {
      const res = await fetch(URL, { method: 'HEAD' })
      if (res.ok || res.status === 404) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/* ── 3. Electron ─────────────────────────────────────────── */

const ok = await waitForServer()
if (!ok) {
  console.error('Vite 一直没起来，放弃')
  shutdown(1)
}

console.log(`\n启动 Electron，加载 ${URL}`)
console.log(`渲染层调试端口：http://127.0.0.1:${DEBUG_PORT}/json/list（Chrome DevTools 可直接打开）`)
if (INSPECT_PORT) console.log(`主进程调试端口：${INSPECT_PORT}（等调试器接入）`)
console.log('')

const electronArgs = ['.', `--remote-debugging-port=${DEBUG_PORT}`]
if (INSPECT_PORT) electronArgs.push(`--inspect=${INSPECT_PORT}`)

const electron = spawn(ELECTRON_BIN, electronArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: URL },
})
children.push(electron)

electron.on('exit', (code) => {
  console.log(`[electron] 退出，代码 ${code}`)
  shutdown(code ?? 0)
})

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
