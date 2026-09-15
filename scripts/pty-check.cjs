/**
 * node-pty 体检
 *
 * 原生模块最容易「装上了但用不了」—— 编译时对着 Node 的 ABI，
 * 跑在 Electron 里就报 MODULE_NOT_FOUND 或者 ABI 不匹配。
 * 所以装完必须用 **Electron 自己的 Node** 再验一遍：
 *
 *   node scripts/pty-check.cjs                        # 纯 Node
 *   ELECTRON_RUN_AS_NODE=1 electron scripts/pty-check.cjs   # Electron ABI
 *
 * 两个都过，才算真的能用。
 */

const path = require('node:path')

let pty
try {
  pty = require('node-pty')
} catch (error) {
  console.error('✗ 加载 node-pty 失败：', error.message)
  console.error('  如果是 ABI 不匹配，跑：npx @electron/rebuild -f -w node-pty')
  process.exit(1)
}

const shell = process.env.ComSpec || 'cmd.exe'
console.log(
  `加载成功 · Node ${process.versions.node}` +
    (process.versions.electron ? ` · Electron ${process.versions.electron}` : '（纯 Node）'),
)
console.log(`模块 ABI = ${process.versions.modules}`)

const child = pty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
})

let raw = ''
child.onData((chunk) => {
  raw += chunk
})

/* 用带 ANSI 的命令，顺便验证「是不是真 TTY」 */
child.write('echo PTY_OK\r\n')

setTimeout(() => {
  try {
    child.kill()
  } catch {
    /* 已经退了 */
  }

  const plain = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
  const sawEscape = /\x1b\[/.test(raw)
  const ok = plain.includes('PTY_OK')

  console.log(`看到命令回显: ${ok ? '是' : '否'}`)
  console.log(`输出里有 ANSI 转义: ${sawEscape ? '是（真 TTY）' : '否（可能不是 TTY）'}`)
  console.log(`输出长度: ${raw.length} 字节`)
  console.log(ok ? '✓ node-pty 可用' : '✗ 没收到预期输出')
  process.exit(ok ? 0 : 1)
}, 2500)

void path
