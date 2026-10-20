/**
 * 开屏「工作区总览」的内核侧（只读）
 *
 * 回答两件事，**全部来自真实数据**：
 *   · 这个目录是什么 —— 名字 / 技术栈 / 测试入口
 *   · Git 摘要 —— 当前分支 / 未提交变更数
 *
 * 三条原则（对齐设计文档 §11 / §17 的「真实状态 + 性能边界」）：
 *   · 只读：git 只用查询子命令；不跑任何会写盘的东西
 *   · 快：单文件读 ≤64KB、git 超时 2.5s —— 开屏第一屏不等它
 *   · 失败可分辨：每个区块各自 ok/error，单项失败不拖垮整个开屏
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const READ_LIMIT = 64 * 1024
const GIT_TIMEOUT_MS = 2500

/** 读一个小文件（最多 64KB）；读不到给 null（不抛） */
function readSmall(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(READ_LIMIT)
      const n = fs.readSync(fd, buf, 0, READ_LIMIT, 0)
      return buf.subarray(0, n).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** package.json 里认得出来的技术栈标签（顺序 = 展示顺序） */
function stackFromPackage(dir) {
  const raw = readSmall(path.join(dir, 'package.json'))
  if (raw === null) return []
  let pkg = null
  try {
    pkg = JSON.parse(raw)
  } catch {
    pkg = null
  }
  const deps =
    pkg && typeof pkg === 'object'
      ? { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      : {}
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name)
  const labels = []
  if (has('electron')) labels.push('Electron')
  if (has('next')) labels.push('Next.js')
  else if (has('react')) labels.push('React')
  if (has('vue')) labels.push('Vue')
  if (has('svelte')) labels.push('Svelte')
  if (has('vite')) labels.push('Vite')
  if (has('typescript') || exists(path.join(dir, 'tsconfig.json'))) labels.push('TypeScript')
  if (has('tailwindcss')) labels.push('Tailwind')
  /* 有 package.json 但没认出框架 —— 至少它是个 Node 项目 */
  if (!labels.length) labels.push('Node')
  return labels
}

/** 浅层技术栈识别：只看目录第一层的几个标志文件，不递归 */
function detectStack(dir) {
  const labels = []
  if (exists(path.join(dir, 'package.json'))) labels.push(...stackFromPackage(dir))
  if (exists(path.join(dir, 'Cargo.toml'))) labels.push('Rust')
  if (exists(path.join(dir, 'go.mod'))) labels.push('Go')
  if (
    exists(path.join(dir, 'pyproject.toml')) ||
    exists(path.join(dir, 'requirements.txt')) ||
    exists(path.join(dir, 'setup.py'))
  ) {
    labels.push('Python')
  }
  if (exists(path.join(dir, 'CMakeLists.txt'))) labels.push('CMake')
  try {
    const entries = fs.readdirSync(dir)
    if (entries.some((n) => /\.(csproj|sln)$/i.test(n))) labels.push('.NET')
    if (entries.includes('Gemfile')) labels.push('Ruby')
  } catch {
    /* 读不到就算了 —— 单项失败不拖垮整个扫描 */
  }
  if (!labels.length && exists(path.join(dir, 'index.html'))) labels.push('Web')
  return [...new Set(labels)].slice(0, 6)
}

/** 有测试入口就给出跑法（只认最常见的三种，多的不猜） */
function testCommandOf(dir) {
  const raw = readSmall(path.join(dir, 'package.json'))
  if (raw !== null) {
    try {
      const pkg = JSON.parse(raw)
      if (pkg && pkg.scripts && typeof pkg.scripts.test === 'string' && pkg.scripts.test.trim()) {
        return 'npm test'
      }
    } catch {
      /* 坏 JSON 就当没有 */
    }
  }
  if (exists(path.join(dir, 'Cargo.toml'))) return 'cargo test'
  if (exists(path.join(dir, 'go.mod'))) return 'go test ./...'
  return ''
}

/** git 查询：只读子命令 + 超时；失败给 ok:false，不抛 */
function gitSummary(dir) {
  const runGit = (args) =>
    spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
  const head = runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.status !== 0) return { ok: false, error: '不是 Git 仓库（或 git 不可用）' }
  const branch = String(head.stdout ?? '').trim() || '(detached)'
  const status = runGit(['status', '--porcelain', '--untracked-files=normal'])
  let changes = 0
  if (status.status === 0) {
    changes = String(status.stdout ?? '')
      .split('\n')
      .filter((line) => line.trim()).length
  }
  return { ok: true, branch, changes }
}

/**
 * 异步版 git 查询 —— **主进程不能被它阻塞**（2026-10-20 实测）。
 *
 * 原来的 `gitSummary` 用 `spawnSync`：两条 git 命令实测 380–420 ms，
 * 期间 Electron 主进程**完全停住**。实测同一时刻的轻量 IPC（`configGet`）
 * 从 2.5 ms 被拖到 **455 ms（慢 182 倍）** —— 这就是用户说的
 * 「软件暂时无响应」的直接成因。
 *
 * 语义与 `gitSummary` 逐字一致（同样的命令、同样的超时、失败都给 ok:false），
 * 只是换 `spawn` + Promise。保留同步版是因为自检 `84-launch-summary` 直接调它。
 */
function gitSummaryAsync(dir) {
  const runGit = (args) =>
    new Promise((resolve) => {
      let child
      try {
        child = spawn('git', ['-C', dir, ...args], { windowsHide: true })
      } catch (error) {
        resolve({ status: -1, stdout: '', error })
        return
      }
      let stdout = ''
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      /* 超时与 spawnSync 的 timeout 同口径：杀掉子进程，按失败处理 */
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
        finish({ status: -1, stdout })
      }, GIT_TIMEOUT_MS)
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
      })
      /* stderr 不收集：只关心 exit code 与 stdout（与同步版一致） */
      child.stderr?.on('data', () => {})
      child.on('error', (error) => finish({ status: -1, stdout, error }))
      child.on('close', (code) => finish({ status: typeof code === 'number' ? code : -1, stdout }))
    })

  return (async () => {
    const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (head.status !== 0) return { ok: false, error: '不是 Git 仓库（或 git 不可用）' }
    const branch = String(head.stdout ?? '').trim() || '(detached)'
    const status = await runGit(['status', '--porcelain', '--untracked-files=normal'])
    let changes = 0
    if (status.status === 0) {
      changes = String(status.stdout ?? '')
        .split('\n')
        .filter((line) => line.trim()).length
    }
    return { ok: true, branch, changes }
  })()
}

/**
 * 开屏要的全部工作区信息。任何一段失败都只是那一段 ok:false，
 * **整个调用保持 ok:true**（开屏局部显示「无法读取」，而不是整块不可用）。
 */
function scanWorkspace(dir) {
  const target = String(dir ?? '')
  if (!target || !exists(target)) {
    return { ok: false, dir: target, error: '目录不存在' }
  }
  const result = { ok: true, dir: target, name: path.basename(target) }
  try {
    result.stack = detectStack(target)
  } catch {
    result.stack = []
  }
  try {
    result.testCommand = testCommandOf(target)
  } catch {
    result.testCommand = ''
  }
  try {
    result.git = gitSummary(target)
  } catch (error) {
    result.git = { ok: false, error: String(error?.message ?? error) }
  }
  return result
}

/**
 * `scanWorkspace` 的**异步版**：IPC 走这个，主进程不再被 git 卡住。
 *
 * 返回形状与同步版逐字一致 —— 只是把 `gitSummary` 换成 `gitSummaryAsync`。
 * 同步版保留给自检（`84-launch-summary` 直接调它），两边共用同一套
 * `detectStack` / `testCommandOf`，没有第二份口径。
 */
async function scanWorkspaceAsync(dir) {
  const target = String(dir ?? '')
  if (!target || !exists(target)) {
    return { ok: false, dir: target, error: '目录不存在' }
  }
  const result = { ok: true, dir: target, name: path.basename(target) }
  try {
    result.stack = detectStack(target)
  } catch {
    result.stack = []
  }
  try {
    result.testCommand = testCommandOf(target)
  } catch {
    result.testCommand = ''
  }
  try {
    result.git = await gitSummaryAsync(target)
  } catch (error) {
    result.git = { ok: false, error: String(error?.message ?? error) }
  }
  return result
}

module.exports = {
  scanWorkspace,
  scanWorkspaceAsync,
  detectStack,
  gitSummary,
  gitSummaryAsync,
  testCommandOf,
}
