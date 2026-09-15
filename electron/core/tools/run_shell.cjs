const { exec } = require('node:child_process')
const { truncateMiddle } = require('./_shared.cjs')

/** 明显会毁掉人的命令，直接拒掉 */
const DANGEROUS = [
  /\brm\s+-rf\s+[\/~]/i,
  /\brm\s+-rf\s+\*/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bdiskpart\b/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bdel\s+\/[sf]\s+\/q\s+[a-z]:\\/i,
  /\brd\s+\/s\s+\/q\s+[a-z]:\\/i,
]

const MAX_OUTPUT = 8000

module.exports = {
  name: 'run_shell',
  description:
    '在系统 shell 里跑一条命令并返回输出。工作目录默认是项目工作目录，可以用 cwd 指定别处。超时会自动杀掉。不要用它跑需要交互的命令。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: { type: 'string', description: '在哪个目录下执行，默认工作目录' },
      timeout: { type: 'integer', description: '超时秒数，默认取设置里的值（一般 60）' },
    },
    required: ['command'],
  },

  async run(args, ctx) {
    const command = String(args.command ?? '').trim()
    if (!command) throw new Error('命令不能为空')

    for (const pattern of DANGEROUS) {
      if (pattern.test(command)) {
        throw new Error(
          `这条命令看起来会破坏系统，已拒绝执行。如果确实需要，请手动在终端里跑。\n${command}`,
        )
      }
    }

    const cwd = args.cwd ? String(args.cwd) : ctx.workdir
    const timeoutSec = Math.min(600, Math.max(5, Number(args.timeout) || ctx.shellTimeout || 60))

    return await new Promise((resolve) => {
      const child = exec(
        command,
        {
          cwd,
          timeout: timeoutSec * 1000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          /* Windows 下 Node 默认用 cmd.exe，这就够了 */
          shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        },
        (error, stdout, stderr) => {
          const parts = []
          const out = String(stdout ?? '').trimEnd()
          const err = String(stderr ?? '').trimEnd()

          if (out) parts.push(out)
          if (err) parts.push(`[stderr]\n${err}`)

          if (error) {
            const code = typeof error.code === 'number' ? error.code : '?'
            const killed = error.killed === true
            parts.push(killed ? `[进程被超时杀掉（${timeoutSec}s）]` : `[退出码 ${code}]`)
          } else {
            parts.push('[退出码 0]')
          }

          resolve(truncateMiddle(parts.join('\n\n') || '（没有输出）', MAX_OUTPUT))
        },
      )

      /* 用户中途中断时，把这个子进程也带走 */
      ctx.signal?.addEventListener(
        'abort',
        () => {
          try {
            child.kill()
          } catch {
            /* 已经退出了 */
          }
        },
        { once: true },
      )
    })
  },

  summarize(args) {
    return `执行命令：${String(args.command ?? '').slice(0, 120)}`
  },
}
