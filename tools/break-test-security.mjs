/**
 * 破坏性测试 E 组：安全边界
 *
 * 直接调工具（不经界面）—— 测的是「工具层拦不拦」，和模型无关，
 * 所以这样最快也最可复现。
 *
 *   node tools/break-test-security.mjs
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))

const workdir = join(ROOT, 'test-env/PersonalAgent/data/workspace')

/** 全部放行 + 自动同意 —— 就是要看工具层自己拦不拦（不靠界面） */
const ctx = {
  workdir,
  permission: 'full',
  shellTimeout: 20,
  log: { info() {}, warn() {}, error() {} },
  sessionId: 'break-test',
  taskId: 'break-test',
  shellPolicy: { medium: 'allow', high: 'allow', critical: 'allow' },
  confirm: async () => ({ ok: true, allowed: true }),
}

let blocked = 0
let passed = 0

function show(label, out) {
  const s = String(out).slice(0, 120).replace(/\s+/g, ' ')
  /* 「拦住了」的标志：错误信息里出现拒绝/越界/危险这类词 */
  const isBlocked = /拒绝|不允许|只读|越界|不在允许|超出|危险|破坏系统/.test(s)
  if (isBlocked) blocked += 1
  else passed += 1
  console.log(`${isBlocked ? '🛡 拦住' : '⚠️  放行'} | ${label}`)
  console.log(`        ${s}`)
}

async function tryTool(label, name, args) {
  try {
    show(label, await tools.execute(name, args, ctx))
  } catch (error) {
    show(label, String(error?.message ?? error))
  }
}

console.log('══ E1 路径穿越 / 越界读 ══')
await tryTool('../../../../Windows/System32/drivers/etc/hosts', 'read_file', {
  path: '../../../../Windows/System32/drivers/etc/hosts',
})
await tryTool('C:\\Windows\\win.ini（绝对路径）', 'read_file', { path: 'C:\\Windows\\win.ini' })
await tryTool('list_dir C:\\', 'list_dir', { path: 'C:\\' })

console.log('\n══ E3 危险命令 ══')
await tryTool('rm -rf /', 'run_shell', { command: 'rm -rf /' })
await tryTool('format C: /q', 'run_shell', { command: 'format C: /q' })
await tryTool('echo hi && del /f /q C:\\Windows\\win.ini', 'run_shell', {
  command: 'echo hi && del /f /q C:\\Windows\\win.ini',
})
await tryTool('powershell Remove-Item -Recurse C:\\', 'run_shell', {
  command: 'powershell -c "Remove-Item -Recurse -Force C:\\"',
})
await tryTool('shutdown /r /t 0', 'run_shell', { command: 'shutdown /r /t 0' })
await tryTool('reg delete HKLM\\...', 'run_shell', {
  command: 'reg delete HKLM\\SOFTWARE\\Microsoft /f',
})

console.log('\n══ 对照：正常操作该放行 ══')
await tryTool('echo hello', 'run_shell', { command: 'echo hello' })
await tryTool('读工作目录内的文件', 'read_file', { path: 'hello.txt' })

console.log(`\n汇总：拦住 ${blocked} 条 / 放行 ${passed} 条`)
