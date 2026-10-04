const { exec } = require('node:child_process')
const encoding = require('../shell-encoding.cjs')
const netPolicy = require('../net-policy.cjs')
const risk = require('../risk.cjs')
const { resolvePath, truncateWithLog } = require('./_shared.cjs')
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

/**
 * 网络策略这一关：**只会把 allow 变严，永远不会把 ask 变松**。
 *
 * 为什么不在这里弹确认：确认界面不在这个文件（在 `tools/index.cjs` 的 approval 流程），
 * 这里弹不出来。所以 `ask` 只有一种安全做法 —— **先看上层到底会不会问**：
 *   · 上层这一档会问（risk.decide → 'ask'）→ 交给它，用户照样看到确认框
 *   · 上层这一档是静默放行（比如 shellPolicy.medium = 'allow'）→ **这里拦掉**，
 *     否则就成了「网络策略说每次先问，结果没人被问就把请求发出去了」
 *
 * @returns {string} 空串 = 放行；非空 = 给用户看的拒绝理由
 */
function networkGuard(command, ctx) {
  const decided = netPolicy.decide({ kind: 'shell', target: command, ctx })
  if (decided.action === 'allow') return ''
  if (decided.action === 'deny') {
    return `这条命令要联网，被网络策略拦下了。\n原因：${decided.reason}\n命令：${command}`
  }

  let upper = ''
  try {
    const verdict = risk.classify(command)
    const policy = ctx.shellPolicy ?? require('../config.cjs').get().tools.shellPolicy
    const decidedUpper = risk.decide(verdict, policy)
    if (risk.rank(verdict.level) >= risk.rank('medium') && decidedUpper.action === 'ask') return ''
    upper = `上层风险分级这一档（${verdict.level}）不会问你（${decidedUpper.action}）`
  } catch (error) {
    upper = `读不到上层的风险策略（${error instanceof Error ? error.message : error}）`
  }

  return (
    `这条命令要联网，网络策略要求「每次先问」，但这一层没有确认界面，${upper} ——\n` +
    '为了不出现「没人被问就把请求发出去」，按拒绝处理。\n' +
    `原因：${decided.reason}\n命令：${command}`
  )
}

/**
 * 执行目录也要过权限边界（审计问题 17）。
 *
 * 文件工具（`read_file` / `write_file`…）都走 `resolvePath`，所以越过工作目录会被
 * 拦下来问用户；但 shell 这条路以前是**裸的** —— `run_shell({ command: 'type C:\\Users\\x\\.ssh\\id_rsa' })`
 * 或直接 `cd /d C:\\` 就绕开了整套边界。这里把 cwd 交给同一个 `resolvePath`：
 *   · 在工作目录内 → 正常放行
 *   · 在外面但拿过授权 → 放行（授权表就在那边）
 *   · 没授权 → 抛 PermissionRequiredError，由 `tools/index.cjs` 转成向用户要授权
 *
 * 没传 cwd 时退到 `ctx.workdir`（和以前一样）—— 没有工作目录可用时只好不管，
 * 交给上层反正会拦（这是现有行为，不在这里改）。
 */
function resolveShellCwd(rawCwd, ctx) {
  const asked = rawCwd === undefined || rawCwd === null || rawCwd === ''
  const wanted = String(asked ? (ctx.workdir ?? '') : rawCwd)
  if (!wanted) return ctx.workdir ?? ''
  return resolvePath(wanted, ctx.workdir ?? '', ctx)
}

module.exports = {
  name: 'run_shell',
  /* 自检直接调它（不必真发请求），见 scripts/selftest/groups/73-net-policy.mjs */
  networkGuard,
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

    /* ── 网络策略：内核级强制（见 net-policy.cjs）── */
    const networkBlocked = networkGuard(command, ctx)
    if (networkBlocked) throw new Error(networkBlocked)

    const cwd = resolveShellCwd(args.cwd, ctx)
    /* 审计里要记**实际**在哪儿跑的（问题 17）：`args.cwd` 是模型自己填的，不填时
       审计里只看得到命令、看不到目录。这里的 `args` 和 `tools/index.cjs` 记审计时
       拿到的是同一个对象，所以就地把实际值回填进去（只在不一样时写一笔）。 */
    if (args.cwd !== cwd) args.cwd = cwd
    const timeoutSec = Math.min(600, Math.max(5, Number(args.timeout) || ctx.shellTimeout || 60))

    return await new Promise((resolve) => {
      const finish = createSettler(resolve)
      /* 先声明再挂监听：onAbort 在 signal 已经断掉时会立刻触发，
         那时 child 还是 null —— killTree(null) 是安全的，这条顺序能兜住 */
      let child = null
      let timer = null
      /* 两条死亡路径（中断 / 超时）都要摘监听、停 timer，收在一处 */
      const done = () => {
        if (timer) clearTimeout(timer)
        timer = null
        off()
      }
      let off = () => {}
      off = onAbort(ctx.signal, () => {
        killTree(child)
        /* 停掉超时 timer —— 不然它 10 分钟后还要醒一次，白拖住进程退出 */
        done()
        /*
         * AG-010：**不等 exec 的 callback**。
         * callback 要等输出管道关掉才来 —— 实测中断之后又等了 29.6 秒
         * （命令自己跑完），等于用户点了停止还得瞪半分钟。
         * 进程已经交给 killTree 了，这里立刻把 Promise 结掉。
         */
        finish('[已被用户中断，这条命令的子进程已经终止]')
      })

      /*
       * 超时自己管（审计问题 16）：
       *
       * 以前把这个交给 `exec` 的 `timeout`，而 Node 内部只 `kill()` 直接子进程
       * （cmd.exe），命令真正在跑的孙子（ping/node/curl…）会变孤儿继续跑 ——
       * 和中断那条路是两个标准，实测过。现在两条路共用 `killTree`（taskkill /T）。
       *
       * ★ 措辞里**必须留着「进程被超时杀掉」**：`task-outcome.cjs` 按这个标记
       *   判「这条命令失败了」（那条正则钉在 `34-outcome` 自检里），改字要同步改它。
       */
      timer = setTimeout(() => {
        killTree(child)
        /* 和中断同一套：不等 callback（管道要等子进程全退才关），立刻结算 */
        finish(`[进程被超时杀掉（${timeoutSec}s）：已连同子进程一起终止]`)
      }, timeoutSec * 1000)

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
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          encoding: 'buffer',
          /* Windows 下 Node 默认用 cmd.exe，这就够了 */
          shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        },
        (error, stdout, stderr) => {
          done()
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

          finish(truncateWithLog(parts.join('\n\n') || '（没有输出）', MAX_OUTPUT, '命令输出超出上限'))
        },
      )
    })
  },

  summarize(args) {
    return `执行命令：${String(args.command ?? '').slice(0, 120)}`
  },
}
