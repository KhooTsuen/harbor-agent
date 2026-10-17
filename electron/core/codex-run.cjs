/**
 * codex **子进程的起停管理**（不 require electron · 纯逻辑可单测）
 *
 * 职责边界：这个文件只管「怎么把 codex 起起来、怎么收摊」；
 * 「事件是什么意思、怎么变成 Harbor 契约」在 `codex-cli.cjs`，JSONL 在 `codex-jsonl.cjs`。
 *
 * ── ★★ 三条安全底线（用户 2026-10-17 第 4、8 条）────────────────
 *
 *   ① **沙箱固定 `read-only`**：`-s read-only` 是常量，**不做成配置项**。
 *      开 `workspace-write` 等于让 codex **绕过 Harbor 的审批直接改用户文件** ——
 *      那正是用户明令禁止的。要能写文件，得走 Harbor 自己的工具链（有审批 + 审计）。
 *   ② **prompt 走 stdin**（`-`），命令行里**只有常量**：用户消息含 `& | %` 时不会被
 *      cmd 解释 —— 用 `shell: true` 传参就是一条命令注入通道（设计 §5.5）。
 *   ③ **取消只按我们起的那个 pid** 杀树（`taskkill /pid N /T`）—— **绝不按映像名**。
 *
 * ── ★ 超时为什么是「两个」而不是一个（实测得出）────────────────
 *
 * 本机 codex 首次响应可能 **>180 秒**（5 次重连 + WS→HTTPS 回退）。所以：
 *   · `idleMs`（默认 5 分钟）：多久没**任何**输出算卡住；
 *   · `totalMs`（默认 15 分钟）：整次调用的硬上限（防「一直有零碎输出但永不结束」）。
 * HTTP 路径那套 `llm-idle.cjs`（45 秒）**刻意不复用** —— 那是给流式 HTTP 的。
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { onAbort } = require('./abort.cjs')
const { createJsonlParser } = require('./codex-jsonl.cjs')

/**
 * 固定的 exec 参数。★ **全是常量** —— 用户内容一律走 stdin，不进命令行（底线 ②）。
 * 末尾的 `-` = 「prompt 从 stdin 读」（`codex exec --help` 的约定）。
 */
const EXEC_ARGS = ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-']

/** 沙箱档：**固定只读**，不做成可配（底线 ①）。改这里前先读文件头。 */
const SANDBOX = 'read-only'

/** 无任何输出多久算卡住（实测首次响应可 >180s，所以给得很宽） */
const DEFAULT_IDLE_MS = 5 * 60 * 1000
/** 整次调用的硬上限 */
const DEFAULT_TOTAL_MS = 15 * 60 * 1000

/**
 * 找 codex 的启动器。
 *
 * `codexPath`（用户可配）优先；否则在 `PATH` 里按 `codex.cmd` → `codex.exe` → `codex`
 * 找 —— **不硬编码本机路径**（设计 §5.4：写死等于「只在某台机器上能跑」）。
 *
 * @param {string} [codexPath]
 * @param {Record<string,string>} [env]
 * @returns {string} 启动器路径（找不到时退回名字，交给 shell 再找一次）
 */
function resolveLauncher(codexPath, env = process.env) {
  const explicit = String(codexPath ?? '').trim()
  if (explicit) return explicit

  const rawPath = String(env.PATH ?? env.Path ?? '')
  const dirs = rawPath.split(path.delimiter).filter(Boolean)
  const names = process.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex']
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name)
      try {
        if (fs.existsSync(full)) return full
      } catch {
        /* 某个目录读不了不该拦住继续找 */
      }
    }
  }
  return names[0]
}

/**
 * 拼命令行（Windows 用）。
 * ⚠️ 基础参数**全是常量**；用户内容一律走 stdin（底线 ②）。
 *
 * `extraArgs` 只给**由 Harbor 自己算出来的**开关用（当前唯一用途：`HARBOR_CODEX_MCP=1`
 * 时注入 MCP server 配置，见 `codex-mcp-lifecycle.cjs` 的 `codexExtraArgs`）。
 * 它**插在末尾那个 `-` 之前** —— `-` 必须留在最后（「prompt 从 stdin 读」的约定）。
 * 默认空数组 → 结果与改动前**逐字节一致**。
 */
function buildCommandLine(launcher, extraArgs = []) {
  const extra = (Array.isArray(extraArgs) ? extraArgs : []).map((a) => String(a))
  const base = EXEC_ARGS.slice(0, -1)
  const tail = EXEC_ARGS[EXEC_ARGS.length - 1]
  return `"${String(launcher)}" ${[...base, ...extra, tail].join(' ')}`
}

/**
 * 交给 `spawn` 的执行体。
 *
 * Windows 上 `.cmd` 不能直接 spawn（Node 20+ 会 EINVAL），必须经 `cmd.exe`；
 * 但我们**不用 `shell: true`**（那会让内容被 shell 解析）—— 而是显式起 `cmd.exe`
 * 并只喂常量命令行。非 Windows 直接执行启动器。
 *
 * ── ★★ `verbatim: true` 是必须的（真机 0.0 秒失败才逮到）────────
 *
 * 命令行里 launcher 带引号（路径可能含空格）。若让 Node 自己拼 Windows 命令行，
 * 它会把这层引号**再转义一次**（传出去是 `\"C:\…\codex.cmd\"`）——
 * cmd 于是把带引号的整串当成命令名，报「不是内部或外部命令」。
 * `windowsVerbatimArguments: true` 让它原样传；配合 `/s`，cmd 按「剥掉首尾引号」
 * 的规则解析，正好执行 `"路径" 常量参数`。
 */
function spawnSpec(launcher, env = process.env, extraArgs = []) {
  const extra = (Array.isArray(extraArgs) ? extraArgs : []).map((a) => String(a))
  if (process.platform === 'win32') {
    const comspec = String(env.ComSpec ?? env.COMSPEC ?? '').trim() || 'cmd.exe'
    return { cmd: comspec, args: ['/d', '/s', '/c', buildCommandLine(launcher, extra)], verbatim: true }
  }
  return { cmd: String(launcher), args: [...EXEC_ARGS.slice(0, -1), ...extra, '-'], verbatim: false }
}

/**
 * 杀掉一棵进程树（取消 / 超时用）。
 *
 * ★ **只按传进来的 pid**（`/T` 连它的子进程）—— 绝不 `taskkill /IM`（按映像名会
 *   连别的窗口一起杀）。`spawnFn` 可注入，便于单测（不真杀进程）。
 *
 * @returns {boolean} 有没有发出杀进程的指令（不代表杀成功）
 */
function killTree(pid, opts = {}) {
  const num = Number(pid)
  if (!Number.isFinite(num) || num <= 0) return false
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn
  try {
    if (process.platform === 'win32') {
      const killer = spawnFn('taskkill', ['/pid', String(num), '/T', '/F'], { stdio: 'ignore' })
      killer?.unref?.()
    } else {
      process.kill(-num, 'SIGKILL')
    }
    return true
  } catch {
    /* 进程可能已经退了 —— 杀失败不是错误 */
    return false
  }
}

/**
 * 跑一次 `codex exec`，把事件按顺序交给 `onEvent`。
 *
 * @param {{ launcher?: string, prompt?: string, cwd?: string, env?: Record<string,string>,
 *           extraArgs?: string[], signal?: AbortSignal, idleMs?: number, totalMs?: number,
 *           onEvent?: (event: object) => void, spawnFn?: Function }} [options]
 * @returns {Promise<{ events: object[], exitCode: number|null, stderrTail: string,
 *           stats: object, timedOut: boolean, aborted: boolean, spawnError: string|null }>}
 *           ★ **不抛**：一切都变成返回值（调用方按「有没有内容」判成败，见 codex-cli）
 */
function runCodex(options = {}) {
  const launcher = String(options.launcher ?? '').trim() || resolveLauncher('')
  const prompt = String(options.prompt ?? '')
  const idleMs = Number(options.idleMs) > 0 ? Number(options.idleMs) : DEFAULT_IDLE_MS
  const totalMs = Number(options.totalMs) > 0 ? Number(options.totalMs) : DEFAULT_TOTAL_MS
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null
  const spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  /* extraArgs：Harbor 自己算的附加参数（如 MCP server 配置）——默认空，行为不变 */
  const spec = spawnSpec(launcher, env, options.extraArgs)

  return new Promise((resolve) => {
    const events = []
    const parser = createJsonlParser()
    let stderrTail = ''
    let settled = false
    let timedOut = false
    let aborted = false
    let exitCode = null
    let spawnError = null
    let child = null
    let offAbort = null
    let idleTimer = null
    let totalTimer = null

    /** 收束（**只做一次**）：清定时器、卸监听、回结果 */
    const finish = () => {
      if (settled) return
      settled = true
      if (idleTimer) clearTimeout(idleTimer)
      if (totalTimer) clearTimeout(totalTimer)
      if (offAbort) offAbort()
      resolve({ events, exitCode, stderrTail, stats: parser.stats, timedOut, aborted, spawnError })
    }

    /** 收摊：取消 / 超时都走这条（先杀树，再收束） */
    const bail = (reason) => {
      if (settled) return
      if (reason === 'timeout') timedOut = true
      if (reason === 'abort') aborted = true
      if (child?.pid) killTree(child.pid, { spawnFn })
      /* 给 kill 一点时间再收束；进程若已退，close 事件会更快 */
      setTimeout(finish, 300)
    }

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => bail('timeout'), idleMs)
      if (typeof idleTimer.unref === 'function') idleTimer.unref()
    }

    try {
      child = spawnFn(spec.cmd, spec.args, {
        cwd: options.cwd || process.cwd(),
        env,
        /* ★ stdin 是**管道**（我们要写 prompt）；stdout/stderr 也管道 */
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        /* Windows：别让 Node 再对命令行做一层引号转义（见 spawnSpec 的注释） */
        windowsVerbatimArguments: spec.verbatim === true,
      })
    } catch (error) {
      spawnError = String((error && error.message) || error)
      finish()
      return
    }

    child.on('error', (error) => {
      /* ENOENT（codex 没装）/ EINVAL 之类 —— 如实回，不抛 */
      spawnError = String((error && error.message) || error)
    })

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => {
      armIdle()
      for (const event of parser.push(chunk)) {
        events.push(event)
        if (onEvent) {
          try {
            onEvent(event)
          } catch {
            /* 回调抛错不该拖垮整次调用 */
          }
        }
      }
    })

    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on('data', (chunk) => {
      armIdle()
      /* 只留尾部：错误消息要用它说清原因，但不能无限攒（内存/日志） */
      stderrTail = (stderrTail + String(chunk)).slice(-400)
    })

    child.on('close', (code) => {
      exitCode = code
      /* 收尾：缓冲区里可能还有最后一行（结尾没换行） */
      for (const event of parser.flush()) {
        events.push(event)
        if (onEvent) {
          try {
            onEvent(event)
          } catch {
            /* 同上 */
          }
        }
      }
      finish()
    })

    /* 取消：杀树 + 收束（与 HTTP 路径同一个语义：抛 AbortError 由上层做） */
    if (options.signal) {
      offAbort = onAbort(options.signal, () => bail('abort'))
      if (options.signal.aborted) bail('abort')
    }

    totalTimer = setTimeout(() => bail('timeout'), totalMs)
    if (typeof totalTimer.unref === 'function') totalTimer.unref()
    armIdle()

    /* 写 prompt 并**立刻关 stdin**（不关会挂死，见实测事实 4） */
    try {
      if (child.stdin) {
        child.stdin.on('error', () => {
          /* 子进程早退会让写失败 —— 不是错误 */
        })
        child.stdin.end(prompt, 'utf8')
      }
    } catch {
      /* 写不进去交给 close/超时 */
    }
  })
}

module.exports = {
  EXEC_ARGS,
  SANDBOX,
  DEFAULT_IDLE_MS,
  DEFAULT_TOTAL_MS,
  resolveLauncher,
  buildCommandLine,
  spawnSpec,
  killTree,
  runCodex,
}
