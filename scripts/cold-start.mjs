/**
 * 冷启动体检（`npm run cold-start`）
 *
 * 为什么要有它：这个项目的「元层」（`AGENT.md` + `docs/` + `scripts/` + 检查链）一直在长，
 * 而**长到什么程度算失衡**一直没有客观信号。干净副本 → 装依赖 → 跑收工链所需的时间，
 * 就是那个信号：它把「元层有多重」翻译成一个能对比、能写进报告的数字。
 *
 * 目标（`docs/约束机制说明.md` 的「数值与文档的落点」与 `docs/README.md` 的约定）：**10 分钟以内**。
 * 超了就说明元层在拖慢上手速度 —— 该做减法，而不是继续加规矩。
 *
 * 做法：在**系统临时目录**里铺一份干净副本（排除 `node_modules` / 构建产物 / 真实 `data/`），
 * 依次计时跑 `npm ci` → `npm run preflight`。全程**不碰真实仓库、不碰真实 data**。
 *
 * 用法：
 *   npm run cold-start                 # 全跑（几分钟起：要下载依赖 + 构建）
 *   npm run cold-start -- --dry        # 只铺副本、报文件数，不装不跑（秒级，验脚本本身）
 *   npm run cold-start -- --keep       # 跑完保留临时目录（排查用）
 *   npm run cold-start -- --budget=15  # 换一条预算线（分钟，默认 10）
 *
 * ★ 它**不进 CI**：要下载 Electron、要跑几分钟，是「人手怀疑自己了就跑一次」的探针，
 *   不是每次 push 的门。别把它接进 `verify`。
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}

if (has('help')) {
  console.log(`用法：
  npm run cold-start                全跑：铺干净副本 → npm ci → npm run preflight（计时）
  npm run cold-start -- --dry       只铺副本、报文件数（秒级）
  npm run cold-start -- --keep      跑完保留临时目录
  npm run cold-start -- --budget=N  预算线（分钟，默认 10）`)
  process.exit(0)
}

const DRY = has('dry')
const KEEP = has('keep')
const BUDGET_MS = Number(arg('budget', '10')) * 60_000

/** 不铺进副本的东西：依赖 / 构建产物 / 真实数据 / 历史副本（`.git` 留着，让用到 git 的检查能跑） */
const EXCLUDE = new Set([
  'node_modules',
  'dist',
  'dist-portable',
  'tmp',
  'backups',
  'shots',
  '.venv',
  'data',
  'test-env',
])

/** 按顶层目录名剔除（`cpSync` 的 filter 返回 false 会跳过整个子树） */
function keepInCopy(src) {
  const rel = relative(ROOT, src)
  if (!rel) return true
  return !EXCLUDE.has(rel.split(sep)[0])
}

function countFiles(dir) {
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name))
    else n += 1
  }
  return n
}

function runStep(name, command, args, cwd) {
  const t0 = performance.now()
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return { name, ms: performance.now() - t0, ok: result.status === 0 }
}

const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`

const base = mkdtempSync(join(tmpdir(), 'harbor-cold-start-'))
const dest = join(base, 'harbor')
console.log(`冷启动体检\n  来源：${ROOT}\n  副本：${dest}\n  预算：${BUDGET_MS / 60_000} 分钟\n`)

let code = 0
try {
  const copyStart = performance.now()
  cpSync(ROOT, dest, { recursive: true, filter: keepInCopy })
  const copyMs = performance.now() - copyStart
  const files = countFiles(dest)
  console.log(`① 铺干净副本：${fmt(copyMs)}，${files} 个文件`)

  const steps = []
  if (DRY) {
    console.log('\n--dry：到此为止（不装依赖、不跑 preflight）。')
  } else {
    console.log('\n② 装依赖（npm ci）…')
    steps.push(runStep('npm ci', 'npm', ['ci'], dest))
    console.log('\n③ 收工链（npm run preflight）…')
    steps.push(runStep('npm run preflight', 'npm', ['run', 'preflight'], dest))
  }

  const total = copyMs + steps.reduce((sum, s) => sum + s.ms, 0)
  console.log('\n—— 结果 ——')
  console.log(`  铺副本      ${fmt(copyMs)}`)
  for (const s of steps) console.log(`  ${s.name.padEnd(11)} ${fmt(s.ms)}${s.ok ? '' : '（失败）'}`)
  console.log(`  合计        ${fmt(total)} / 预算 ${fmt(BUDGET_MS)}`)

  const over = total > BUDGET_MS
  const failed = steps.some((s) => !s.ok)
  if (DRY) console.log('  （--dry 不判定预算）')
  else if (failed) console.log('  ✗ 有步骤失败 —— 冷启动这条路现在是坏的')
  else if (over) console.log(`  ✗ 超预算 ${fmt(total - BUDGET_MS)} —— 元层该做减法了（见 docs/约束机制说明.md 的「数值与文档的落点」）`)
  else console.log(`  ✓ 在预算内，余 ${fmt(BUDGET_MS - total)}`)

  if (failed || (!DRY && over)) code = 1
} finally {
  if (KEEP) console.log(`\n副本保留在：${dest}`)
  else rmSync(base, { recursive: true, force: true })
}

process.exit(code)
