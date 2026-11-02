const { exec } = require('node:child_process')
const encoding = require('../shell-encoding.cjs')
const { truncateWithLog } = require('./_shared.cjs')
const { createSettler, killTree, onAbort } = require('../abort.cjs')
/* 网络策略 / 执行目录两个关卡 —— 搬到 run-shell-guard.cjs（理由见那边文件头） */
const { networkGuard, resolveShellCwd } = require('./run-shell-guard.cjs')

/**
 * 明显会毁掉人的命令，**直接拒掉、没有「确认后放行」这一档**。
 *
 * 和 `risk.cjs` 的分级是两层：那边负责「分级 + 让用户确认」，这边是**最后一道**，
 * 只管那些「agent 任何情况下都不该做」的（格式化磁盘、关机器、建账户）。
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

/*
 * B1（Phase 5）：长命令期间的心跳间隔。
 *
 * 渲染层的兜底时钟判的是「连续多久没收到事件」（300s），而这里单条命令允许跑到
 * 600s —— 不发心跳的话，一条**正常**的长命令（`npm run verify` 那类）会被必然
 * 误判成卡死：界面放弃接收、后台还在跑（见 docs/research/phase5-turn-lifecycle-design.md）。
 * 15s 远小于 300s 的阈值，也远小于这里的 600s 上限 —— 稳稳跑在阈值之内。
 *
 * `HARBOR_SHELL_HEARTBEAT_MS` 是**测试用的口子**（自检 140 组调小到几百毫秒真跑一遍）；
 * 真机不设它。★ 每次调用时读 —— 模块级常量不行：别的自检组会先把本模块 require 进来，
 * 那时 env 还没设，常量就永远停在默认值（第 1 版就栽在这儿，心跳 0 次）。
 */
function heartbeatMs() {
  const override = Number(process.env.HARBOR_SHELL_HEARTBEAT_MS)
  return override > 0 ? override : 15 * 1000
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
    /*
     * 所有 return / finish 都返回结构化结果 `{ text, toolOk, … }`：`text` 一字不差，
     * 多的只是几个字段。为什么要带退出码回去 —— 见 `core/tool-failure.cjs` 文件头。
     */
    const stopped = { text: '[用户已停止：命令没有启动]', toolOk: false, aborted: true }
    if (ctx.signal?.aborted) return stopped

    return await new Promise((resolve) => {
      const finish = createSettler(resolve)
      /* 先声明再挂监听：onAbort 在 signal 已经断掉时会立刻触发，
         那时 child 还是 null —— killTree(null) 是安全的，这条顺序能兜住 */
      let child = null
      let timer = null
      let killTimer = null
      let heartbeat = null
      const stopHeartbeat = () => {
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = null
      }
      /* 两条死亡路径（中断 / 超时）都要摘监听、停 timer，收在一处 */
      const done = () => {
        if (timer) clearTimeout(timer)
        timer = null
        if (killTimer) clearTimeout(killTimer)
        killTimer = null
        stopHeartbeat()
        off()
      }
      let off = () => {}
      off = onAbort(ctx.signal, () => {
        if (!child) {
          done()
          finish(stopped)
          return
        }
        const settleKill = createSettler(({ status, reason }) => {
          if (killTimer) clearTimeout(killTimer)
          done()
          const message =
            status === 'terminated'
              ? '系统已确认终止命令进程树'
              : status === 'already-exited'
                ? '停止时命令已结束'
                : status === 'unknown'
                  ? '已发送终止请求，但未能确认进程退出'
                  : `终止命令失败，进程可能仍在运行：${reason ?? '未知原因'}`
          ctx.log?.info?.(message)
          ctx.emit?.({
            type: 'notice',
            level: status === 'failed' || status === 'unknown' ? 'warning' : 'info',
            title: '命令停止结果',
            text: message,
          })
          finish({ text: `[已被用户中断；停止结果：${message}]`, toolOk: false, aborted: true })
        })
        killTimer = setTimeout(() => settleKill({ status: 'unknown' }), 3000)
        killTree(child, settleKill)
      })
      if (ctx.signal?.aborted && !child) {
        done()
        finish(stopped)
        return
      }

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
        stopHeartbeat()
        /* 和中断同一套：不等 callback（管道要等子进程全退才关），立刻结算 */
        finish({
          text: `[进程被超时杀掉（${timeoutSec}s）：已连同子进程一起终止]`,
          toolOk: false,
          timedOut: true,
        })
      }, timeoutSec * 1000)

      /*
       * B1（Phase 5）：跑起来之后每 HEARTBEAT_MS 报一次平安。
       * 走的是工具早已铺好、却一直没人用的 `ctx.progress`（事件 `agent.tool.progress`，
       * 见 tool-run-ctx.cjs）—— 渲染层收到任何事件都会把它的兜底时钟往后推，
       * 于是「长命令静默」不再被当成「卡死」（RC-2）。
       */
      heartbeat = setInterval(() => {
        try {
          ctx.progress?.({ note: '命令还在跑', percent: null })
        } catch {
          /* 报平安失败不该影响命令本身 */
        }
      }, heartbeatMs())

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
          if (ctx.signal?.aborted) return // 取消结果由进程树终止回执统一结算。
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

          const text = truncateWithLog(
            parts.join('\n\n') || '（没有输出）',
            MAX_OUTPUT,
            '命令输出超出上限',
          )
          /*
           * 退出码结构化回报：`exec` 的 `error.code` 数字是进程退出码（1 / 2 / 8…），
           * 字符串是系统错误码（'ENOENT' 命令没找到 / 'EACCES' 没权限）—— 后者说明
           * 进程根本没起来，`exitCode` 必须是 null，不能拿 -1 冒充退出码。
           */
          const rawCode = error?.code
          const exitCode = typeof rawCode === 'number' ? rawCode : error ? null : 0
          finish({
            text,
            toolOk: !error,
            exitCode,
            /*
             * `error.code` 是字符串时就是系统错误码（ENOENT / EACCES…）——
             * 那说明进程根本没起来，与「跑了但退出码非零」是两件事。
             * 以前这个事实被直接丢掉（`systemCode` 恒为 null），
             * 上层只能靠中文文案猜；现在原样往上递，由 `tool-failure.systemCodeOf` 校验形状。
             */
            ...(typeof rawCode === 'string' ? { systemCode: rawCode } : {}),
            ...(error?.killed === true ? { timedOut: true } : {}),
          })
        },
      )
      /* 可选钩子用于确认项目测试取消后进程确实退出（project-test-run.cjs B3）。 */
      try {
        ctx.onChild?.(child)
      } catch {
        /* 回调自己坏了不该影响命令本身 */
      }
    })
  },

  summarize(args) {
    return `执行命令：${String(args.command ?? '').slice(0, 120)}`
  },
}
