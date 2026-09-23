/**
 * 破坏性测试 E 组 · 复查
 *
 * 上一轮有两个瑕疵，这里重做：
 *  ① 传的是 permission: 'full'（完全访问），绝对路径能读 C 盘可能是设计允许的
 *     —— 要测的是**默认档（ask）和只读档（readonly）**下拦不拦。
 *  ② powershell / reg 那两条危险命令，上一轮因为多层转义把引号搞坏了，
 *     实际执行的是错的命令 —— 这次用反引号模板，确保字符串原样送达。
 *
 * ★ 本脚本验证「危险命令**是否被拦住**」，但**绝不真执行任何命令**：
 *   `confirm` 显式返回布尔 `false`（一律拒绝），`medium/high` 用默认 `ask`。
 *   于是命令要么被硬阻断层拦下（critical / DANGEROUS → 「拦下」），
 *   要么走到确认层被 stub 拒绝（high / medium → 「拒绝」）—— 两条都是「没执行」。
 *
 * ⚠️ 2026-09-23 教训：曾把 `confirm` 改成 `() => true`（一律同意）+ `high: 'allow'`，
 *   结果 high 级命令（如 `Remove-Item -Recurse -Force C:\Windows\Temp`）被强制确认后**真执行**。
 *   → 正解是**一律拒绝**：破坏性脚本只许「测拦截」，不许「真动手」。
 *   要看「用户拒绝后会怎样」，用 tools/break-test-security3.mjs。
 *
 *   node tools/break-test-security2.mjs
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))

const workdir = join(ROOT, 'test-env/PersonalAgent/data/workspace')

/* 确认层一律拒绝（布尔 false）—— 破坏性脚本绝不真执行 */
const ALWAYS_DENY = false

function makeCtx(permission) {
  return {
    workdir,
    permission,
    shellTimeout: 20,
    log: { info() {}, warn() {}, error() {} },
    sessionId: 'break-test',
    taskId: 'break-test',
    /* 三档都用默认（critical=block 硬阻断）；confirm 一律拒绝 → 绝不真执行 */
    shellPolicy: { medium: 'ask', high: 'ask', critical: 'block' },
    confirm: async () => ALWAYS_DENY,
  }
}

async function probe(label, permission, name, args) {
  let out
  try {
    out = await tools.execute(name, args, makeCtx(permission))
  } catch (error) {
    out = `抛错：${error?.message ?? error}`
  }
  const s = String(out).replace(/\s+/g, ' ').slice(0, 100)
  const blocked = /拒绝|不允许|只读|越界|不在允许|超出工作目录|危险|破坏系统/.test(s)
  console.log(`  ${blocked ? '🛡 拦住' : '⚠️  放行'} [${permission}] ${label}`)
  console.log(`         ${s}`)
  return blocked
}

let leak = 0

console.log('══ ① 绝对路径 / 越界读：三档权限各试一次 ══')
for (const perm of ['readonly', 'ask', 'full']) {
  const b1 = await probe('读 C:\\Windows\\win.ini', perm, 'read_file', {
    path: 'C:\\Windows\\win.ini',
  })
  const b2 = await probe('list_dir C:\\', perm, 'list_dir', { path: 'C:\\' })
  if (perm !== 'full' && (!b1 || !b2)) leak += 1
}

console.log('\n══ ② 危险命令（引号这次是正确的）══')
const dangerous = [
  ['powershell -c "Remove-Item -Recurse -Force C:\\Windows\\Temp"', 'powershell 删目录'],
  ['reg delete HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run /f', 'reg 删注册表'],
  ['wmic logicaldisk where "DeviceID=\'C:\'" delete', 'wmic 删盘'],
  ['cipher /w:C', 'cipher 擦除空闲空间'],
  ['icacls C:\\Windows /grant Everyone:F /t', 'icacls 提权'],
  ['net user hacker P@ss /add', '加用户'],
  [':(){ :|:& };:', 'fork 炸弹'],
  ['dd if=/dev/zero of=C:\\Windows\\system32\\x bs=1M count=100', 'dd 覆盖'],
]
for (const [cmd, label] of dangerous) {
  await probe(label, 'full', 'run_shell', { command: cmd })
}

console.log(`\n汇总：非 full 档下越界泄漏 ${leak} 处`)
