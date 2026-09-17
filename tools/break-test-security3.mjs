/**
 * 破坏性测试 E 组 · 干净重测
 *
 * 上一轮的教训：脚本里写了 `confirm: () => ({ ok: true })`，等于替用户
 * 把所有确认都点了「同意」—— 工具层于是正常地记下授权，下次就放行了。
 * **测量工具本身篡改了被测对象**。
 *
 * 这次：
 *   · 每次跑用一个全新的 sessionId（不复用任何已有授权）
 *   · confirm 一律返回「拒绝」—— 看它被拒绝之后还能不能读
 *   · 顺带把「用户同意后才放行」这条也验一遍
 *
 *   node tools/break-test-security3.mjs
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))

const workdir = join(ROOT, 'test-env', 'PersonalAgent', 'data', 'workspace')

/** 全新会话，避免命中历史授权 */
const freshSession = `break-${Date.now()}`

function ctx(confirmAnswer) {
  return {
    workdir,
    permission: 'full',
    shellTimeout: 20,
    log: { info() {}, warn() {}, error() {} },
    sessionId: freshSession,
    taskId: freshSession,
    /* 用真实默认值：critical 是 block */
    shellPolicy: { medium: 'ask', high: 'ask', critical: 'block' },
    confirm: async () => confirmAnswer,
  }
}

/* 真实实现（handlers/chat.cjs 的 askUser）返回的就是布尔 ——
   上一轮传对象是错的：对象永远 truthy，工具层会当成「同意」 */
const deny = false
const allow = true

async function probe(label, answer, name, args) {
  let out
  try {
    out = await tools.execute(name, args, ctx(answer))
  } catch (error) {
    out = `抛错：${error?.message ?? error}`
  }
  const s = String(out).replace(/\s+/g, ' ').slice(0, 90)
  const blocked = /拒绝|不允许|只读|越界|不在允许|工作目录之外|危险|破坏系统/.test(s)
  console.log(`  ${blocked ? '🛡 拦住' : '⚠️  放行'} [用户${answer ? '同意' : '拒绝'}] ${label}`)
  console.log(`         ${s}`)
  return blocked
}

console.log(`会话：${freshSession}（全新，无历史授权）\n`)

console.log('══ ① 用户拒绝时，越界读能不能得逞 ══')
const r1 = await probe('读 C:\\Windows\\win.ini', deny, 'read_file', { path: 'C:\\Windows\\win.ini' })
const r2 = await probe('list_dir C:\\', deny, 'list_dir', { path: 'C:\\' })
const r3 = await probe('读凭证库', deny, 'read_file', { path: join(ROOT, 'data', 'credentials.json') })
const r4 = await probe('读工作目录内的文件（该放行）', deny, 'read_file', { path: 'hello.txt' })

console.log('\n══ ② 用户同意后才放行（对照）══')
const r5 = await probe('读 C:\\Windows\\win.ini（这次同意）', allow, 'read_file', { path: 'C:\\Windows\\win.ini' })

console.log('\n══ ③ 危险命令：用真实默认 policy（critical=block）══')
const cmds = [
  ['rm -rf /', 'rm -rf'],
  ['format C: /q', 'format'],
  ['shutdown /r /t 0', 'shutdown'],
  ['powershell -c "Remove-Item -Recurse -Force C:\\Windows\\Temp"', 'powershell 删目录'],
  ['reg delete HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run /f', 'reg 删注册表'],
  ['cipher /w:C', 'cipher 擦盘'],
  ['net user hacker P@ss /add', '加用户'],
  ['icacls C:\\Windows /grant Everyone:F /t', 'icacls 提权'],
  ['echo hello', '（对照：正常命令）'],
]
for (const [cmd, label] of cmds) {
  await probe(label, deny, 'run_shell', { command: cmd })
}

console.log(`\n结论：越界读被拦 ${[r1, r2, r3].filter(Boolean).length}/3，` +
  `工作目录内放行=${!r4}，同意后放行=${!r5}`)
