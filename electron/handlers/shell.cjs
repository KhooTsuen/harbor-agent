/**
 * 终端执行
 *
 * 右栏那个「终端」标签背后真跑命令。输出是流式的，长命令能边跑边看。
 *
 * **这是「一次性执行」那条路，不是交互式终端。** 没有 stdin，所以
 * vim / top / python REPL 这类程序会卡在那里等输入。
 * 交互式终端在 core/pty.cjs，两边并存、各管一块：
 *   · 模型调 run_shell 工具、前端跑一条命令  → 走这里
 *   · 用户在终端面板里直接敲键盘              → 走 pty.cjs
 *
 * cwd 状态存在主进程里：`cd` 单独拦截（改状态，不真的 spawn），
 * 别的命令带上当前 cwd 跑。这样写 `cd src` 然后再 `ls` 是符合直觉的。
 */

const { spawn } = require('node:child_process')
const path = require('node:path')
const config = require('../core/config.cjs')
const log = require('../core/log.cjs')
const risk = require('../core/risk.cjs')
const audit = require('../core/audit.cjs')

/** 一次的默认超时（秒）。不设的话一条卡住的命令会把终端占死 */
const DEFAULT_TIMEOUT = 120
const MAX_OUTPUT = 2 * 1024 * 1024

/** 当前工作目录（相对主进程，跨命令保持） */
let cwd = ''

/** requestId -> { child, timer } */
const running = new Map()

function baseDir() {
  const configured = config.get().general.workdir
  const { DIRS } = require('../core/paths.cjs')
  if (configured) return configured
  return DIRS.workspace
}

function currentCwd() {
  if (!cwd) cwd = baseDir()
  return cwd
}

/** 危险命令挡在界面层（模型那边另有一套，在 tools/index.cjs） */
const BLOCKED = [
  /\brm\s+-rf\s+[/\\]\s*$/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/,
  /\bdel\s+\/[sf]\s+\/[qsf]\s+[a-z]:\\?\s*$/i,
]

function checkBlocked(command) {
  for (const pattern of BLOCKED) {
    if (pattern.test(command)) return '这条命令太危险，拦下了。'
  }
  return null
}

/** `cd xxx` 单独处理：只改状态，不 spawn */
function tryHandleCd(command) {
  const match = command.trim().match(/^cd(?:\s+(.+?))?\s*$/i)
  if (!match) return null

  const target = (match[1] ?? '').trim().replace(/^"|"$/g, '')
  const next = target
    ? path.isAbsolute(target)
      ? path.normalize(target)
      : path.resolve(currentCwd(), target)
    : baseDir()

  const fs = require('node:fs')
  if (!fs.existsSync(next)) return { ok: false, output: `目录不存在：${next}\n` }
  if (!fs.statSync(next).isDirectory()) return { ok: false, output: `不是目录：${next}\n` }

  cwd = next
  return { ok: true, output: '', cwd }
}

function register({ ipcMain }) {
  ipcMain.handle('shell:cwd', () => ({ cwd: currentCwd() }))

  /** 改工作目录（界面里切换项目时调） */
  ipcMain.handle('shell:reset', () => {
    cwd = baseDir()
    return { cwd }
  })

  /**
   * 跑一条命令。
   *
   * 输出通过 `shell:data` 事件流式推回渲染层，跑完再 resolve。
   * 渲染层的 onShellData 监听里按 requestId 过滤。
   */
  ipcMain.handle('shell:run', (event, payload) => {
    const command = String(payload?.command ?? '').trim()
    const requestId = String(payload?.requestId ?? `sh-${Date.now()}`)

    if (!command) return { ok: false, error: '命令是空的' }

    /* cd 不上 spawn */
    const cdResult = tryHandleCd(command)
    if (cdResult) return { ...cdResult, requestId }

    const inspected = inspectCommand(command)
    if (inspected.block) {
      audit.record({
        sessionId: 'terminal',
        tool: 'terminal_command',
        args: { command },
        permission: config.get().tools.permission,
        ok: false,
        error: `风险等级 ${inspected.verdict.level} 被阻止`,
        extras: { risk: inspected.verdict },
      })
      return { ok: false, error: inspected.block, requestId }
    }

    const timeoutSec = Math.min(600, Math.max(5, Number(payload?.timeout) || DEFAULT_TIMEOUT))
    const send = (stream, text) => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send('shell:data', { requestId, stream, text })
        }
      } catch {
        /* 窗口关了就算了 */
      }
    }

    return new Promise((resolve) => {
      let output = ''
      let finished = false

      const finish = (result) => {
        if (finished) return
        finished = true
        const entry = running.get(requestId)
        if (entry) {
          clearTimeout(entry.timer)
          running.delete(requestId)
        }
        resolve({ ...result, requestId, cwd: currentCwd() })
      }

      /* Windows 下先切到 UTF-8，不然中文输出是乱码 */
      const isWin = process.platform === 'win32'
      const finalCommand = isWin ? `chcp 65001 >nul && ${command}` : command

      let child
      try {
        child = spawn(finalCommand, {
          cwd: currentCwd(),
          shell: true,
          windowsHide: true,
          env: process.env,
        })
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }

      const timer = setTimeout(() => {
        send('stderr', `\n[超时 ${timeoutSec} 秒，已终止]\n`)
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
        finish({ ok: false, error: `超时（${timeoutSec} 秒）`, output })
      }, timeoutSec * 1000)

      running.set(requestId, { child, timer })

      const collect = (stream) => (chunk) => {
        const text = String(chunk)
        output += text
        if (output.length > MAX_OUTPUT) {
          try {
            child.kill()
          } catch {
            /* 忽略 */
          }
          return
        }
        send(stream, text)
      }

      child.stdout?.on('data', collect('stdout'))
      child.stderr?.on('data', collect('stderr'))

      child.on('error', (error) => {
        finish({ ok: false, error: error.message, output })
      })

      child.on('close', (code) => {
        finish({ ok: code === 0, code: code ?? -1, output })
      })

      /* 记一笔，方便排查「为什么这条命令跑了半小时」 */
      log.info(`终端执行：${command.slice(0, 120)}`)

      audit.record({
        sessionId: 'terminal',
        tool: 'terminal_command',
        args: { command, cwd: currentCwd() },
        permission: config.get().tools.permission,
        /* 没有 startedAt —— record() 会按当前时间当起止，ms 计为 0。
           终端是流式的，跑完才算「一次」，这里只记「发起过」。 */
        ok: true,
        extras: { risk: inspected.verdict },
      })
    })
  })

  /** 中断正在跑的命令 */
  ipcMain.handle('shell:abort', (_event, requestId) => {
    const entry = running.get(String(requestId))
    if (!entry) return { ok: false, error: '没有正在跑的命令' }
    try {
      entry.child.kill()
    } catch {
      /* 忽略 */
    }
    return { ok: true }
  })

  /** 中断所有（窗口关闭时用） */
  ipcMain.handle('shell:abortAll', () => {
    for (const [, entry] of running) {
      try {
        entry.child.kill()
      } catch {
        /* 忽略 */
      }
    }
    running.clear()
    return { ok: true }
  })
}

module.exports = { register, currentCwd, DEFAULT_TIMEOUT }
