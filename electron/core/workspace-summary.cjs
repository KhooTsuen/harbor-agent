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
const { spawnSync } = require('node:child_process')

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

module.exports = { scanWorkspace, detectStack, gitSummary, testCommandOf }
