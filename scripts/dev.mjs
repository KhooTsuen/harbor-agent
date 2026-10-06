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
 *
 * 第四件事（2026-10-07 加的）：**监听 electron/，变了就重启主进程**。
 *   原因很具体：vite 只热更新**渲染层**，改内核（electron/ 下的 .cjs）不重启
 *   就不生效 —— 「改了内核却看到旧行为」已经不是踩一次了。与其每次手动重开，
 *   不如让 dev 自己重起。想手动控制时设 DEV_NO_WATCH=1。
 */

import { spawn } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
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

/* 正在主动退出 —— 重启逻辑靠它区分「用户在退窗口」和「我们为了重启而杀」 */
let shuttingDown = false

function shutdown(code = 0) {
  shuttingDown = true
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

/* 这一次是我的「重启」杀的它 —— 标志钉在**这个进程对象**上，不用共享变量。
   踩过的坑（2026-10-07 真机实测）：起先用一个共享的 flag，结果
   taskkill 的 exit 先把 flag 清掉、被杀 Electron 的 exit 后到，
   于是走进「用户关窗口」分支 → 整个 dev 退出、新实例根本没起来。
   钉在进程对象上就没这个先后问题：**杀之前**它已经是 true 了。 */
let current = null
let pendingRestart = null

function startElectron() {
  const proc = spawn(ELECTRON_BIN, electronArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: URL },
  })
  children.push(proc)
  current = proc
  proc.on('exit', (code) => {
    if (proc.restarting) return /* 我们主动杀的，准备重起 */
    console.log(`[electron] 退出，代码 ${code}`)
    shutdown(code ?? 0)
  })
  return proc
}

startElectron()

/* ── 4. 改 electron/ 就重启主进程 ─────────────────────────── */

/* 用 taskkill /T /F 连子进程一起收：Windows 上只 kill 主进程的话，
   渲染 / GPU 子进程可能赖着不放**单实例锁**，新实例一起来就被顶回去。 */
function restartElectron(reason) {
  const proc = current
  if (!proc || proc.exitCode !== null || proc.killed) return
  proc.restarting = true
  console.log(`\n[dev] ${reason} → 重启主进程（渲染层不动，vite 继续热更新）`)
  spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', () => {
    /* 等锁释放了再起新的 —— 起早了会被单实例锁顶掉 */
    setTimeout(() => {
      if (!shuttingDown) startElectron()
    }, 500)
  })
}

if (process.env.DEV_NO_WATCH !== '1') {
  try {
    /* 开头 2 秒内的通知一律不当真：Windows 的 fs.watch(recursive) 会在挂上监听的
       那一刻丢一批**假事件**（实测报 `handlers\profile.cjs 变了`，而那文件的
       修改时间还停在几周前）。不挡掉的话，每次 npm run dev 都会立刻空重启一次。 */
    const startedAt = Date.now()
    const watcher = watch(resolve(ROOT, 'electron'), { recursive: true }, (_event, file) => {
      if (!file || !/\.(cjs|mjs|js|json)$/.test(file)) return
      if (Date.now() - startedAt < 2000) return
      if (pendingRestart) clearTimeout(pendingRestart)
      /* 防抖：一次保存可能触发好几个事件，300ms 内只重启一次 */
      pendingRestart = setTimeout(() => restartElectron(`electron/${file} 变了`), 300)
    })
    process.on('exit', () => watcher.close())
    console.log('监听 electron/ —— 改了主进程代码会自动重启（DEV_NO_WATCH=1 可关）\n')
  } catch (err) {
    console.error('[dev] 监听 electron/ 失败，自动重启关闭：', err.message)
  }
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
