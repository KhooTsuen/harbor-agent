const { exec } = require('node:child_process')
const encoding = require('../shell-encoding.cjs')
const { truncateMiddle } = require('./_shared.cjs')
const { createSettler, killTree, onAbort } = require('../abort.cjs')

/**
 * 明显会毁掉人的命令，**直接拒掉、没有「确认后放行」这一档**。
 *
 * 和 `risk.cjs` 的分级是两层：那边负责「分级 + 让用户确认」，这边是**最后一道**，
 * 只管那些「agent 任何情况下都不该做」的（格式化磁盘、关机器、建账户）。
 * 所以这里宁可和那边重复 —— 重复的代价是多写几行，漏掉的代价是不可挽回。
 */
const DANGEROUS = [
  /\brm\s+-rf\s+[\/~]/i,
  /\brm\s+-rf\s+[a-z]:/i, // Windows 盘符：原来只挡了 / 和 ~
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
  /* ── ↓ 2026-09-23 补：这张表原来只有 cmd / unix 写法，PowerShell 的同义命令一条都没拦到 ── */
  /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i,
  /\b(Stop-Computer|Restart-Computer)\b/i,
  /\bvssadmin\s+delete\s+shadows/i, // 卷影副本删了就真没得恢复了
  /\bnet\s+user\s+\S+\s+[^\n]*\/add\b/i, // 建账户 = 拿下整台机器
  /\bnet\s+(localgroup|group)\s+\S+\s+[^\n]*\/add\b/i,
  /\b(New-LocalUser|Add-LocalGroupMember)\b/i,
  /\bwmic\b[^\n]*\b(format|delete)\b/i,
  /\bRemove-Item\b[^\n]*-Recurse\b[^\n]+\s(['"]?[a-zA-Z]:[\\/]?['"]?|\\{1,2}|\/)\s*$/i, // 递归删整个盘根 = rm -rf /
  /\bRemove-Item\b[^\n]*-(?:Path|LiteralPath)\s+['"]?[a-zA-Z]:[\\/]?['"]?[^\n]*-Recurse\b/i, // -Path C:\ -Recurse 写法
  /\bdd\s+if=.*of=[a-z]:[\\/]/i, // dd 往 Windows 盘上写
  /\bfind\s+(\.|\/|[a-zA-Z]:)\s[^\n]*-delete\b/i, // `find . -delete`：实测原来判成 low 且静默执行
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\.|\/|[a-zA-Z]:)$/i,
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
      const finish = createSettler(resolve)
      /* 先声明再挂监听：onAbort 在 signal 已经断掉时会立刻触发，
         那时 child 还是 null —— killTree(null) 是安全的，这条顺序能兜住 */
      let child = null
      const off = onAbort(ctx.signal, () => {
        killTree(child)
        /*
         * AG-010：**不等 exec 的 callback**。
         * callback 要等输出管道关掉才来 —— 实测中断之后又等了 29.6 秒
         * （命令自己跑完），等于用户点了停止还得瞪半分钟。
         * 进程已经交给 killTree 了，这里立刻把 Promise 结掉。
         */
        finish('[已被用户中断，这条命令的子进程已经终止]')
      })

      /*
       * ★ 输出按**字节**收（encoding: 'buffer'），再交给 shell-encoding 去解。
       *   中文 Windows 上 cmd 自己的输出是 GBK，exec 默认按 UTF-8 解会全是乱码。
       *   （这里试过 `chcp 65001` 前缀，没用：输出走管道时没有控制台，
       *   cmd 内建命令照样按 OEM 代码页写字节。）
       */
      child = exec(
        command,
        {
          cwd,
          timeout: timeoutSec * 1000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          encoding: 'buffer',
          /* Windows 下 Node 默认用 cmd.exe，这就够了 */
          shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        },
        (error, stdout, stderr) => {
          off()
          const parts = []
          const out = encoding.decode(stdout).trimEnd()
          const err = encoding.decode(stderr).trimEnd()

          if (out) parts.push(out)
          if (err) parts.push(`[stderr]\n${err}`)

          if (error) {
            const code = typeof error.code === 'number' ? error.code : '?'
            const killed = error.killed === true
            parts.push(killed ? `[进程被超时杀掉（${timeoutSec}s）]` : `[退出码 ${code}]`)
          } else {
            parts.push('[退出码 0]')
          }

          finish(truncateMiddle(parts.join('\n\n') || '（没有输出）', MAX_OUTPUT))
        },
      )
    })
  },

  summarize(args) {
    return `执行命令：${String(args.command ?? '').slice(0, 120)}`
  },
}
