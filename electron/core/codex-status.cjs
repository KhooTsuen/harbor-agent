/** Read-only local CLI checks. Output is classified here and never sent to the renderer. */
const { spawn } = require('node:child_process')
const { resolveLauncher } = require('./codex-run.cjs')
const { buildEnv } = require('./codex-cli.cjs')
const { safePath } = require('./codex-mcp-lifecycle.cjs')
const { killTree } = require('./abort.cjs')

function checkCommand(launcher, args, env, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    const cmd = win ? String(env.ComSpec ?? env.COMSPEC ?? 'cmd.exe') : launcher
    const argv = win ? ['/d', '/s', '/c', `"${launcher}" ${args.join(' ')}`] : args
    let child
    let output = ''
    let done = false
    const settle = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      killTree(child, () => settle({ code: -1, output: '', timeout: true }))
      setTimeout(() => settle({ code: -1, output: '', timeout: true }), 2000).unref()
    }, timeoutMs)
    try {
      child = spawn(cmd, argv, {
        env,
        windowsHide: true,
        windowsVerbatimArguments: win,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const append = (chunk) => {
        output = (output + String(chunk)).slice(-2048)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      child.once('error', () => settle({ code: -1, output: '' }))
      child.once('close', (code) => settle({ code: code ?? -1, output }))
    } catch {
      settle({ code: -1, output: '' })
    }
  })
}

async function checkCodex(provider) {
  const env = buildEnv(provider)
  const launcher = resolveLauncher(provider?.codexPath, env)
  if (!safePath(launcher))
    return {
      ok: false,
      installation: 'unknown',
      login: 'unknown',
      error: '启动器路径含不能安全执行的字符，请检查路径',
    }
  const version = await checkCommand(launcher, ['--version'], env)
  if (version.code !== 0 || !/codex/i.test(version.output))
    return {
      ok: false,
      installation: version.timeout ? 'unknown' : 'missing',
      login: 'unknown',
      error: version.timeout ? '安装检查超时，请重试' : '未找到可运行的 Codex CLI，请先安装',
    }
  const login = await checkCommand(launcher, ['login', 'status'], env)
  const signedOut = /not logged in|not authenticated|no credentials/i.test(login.output)
  const signedIn = login.code === 0 && /logged in|authenticated/i.test(login.output) && !signedOut
  return {
    ok: signedIn,
    installation: 'available',
    login: signedIn ? 'signed-in' : signedOut ? 'signed-out' : 'unknown',
    error: signedIn
      ? undefined
      : signedOut
        ? 'Codex CLI 尚未登录，请在终端运行 codex login'
        : login.timeout
          ? '登录状态检查超时，请重试'
          : '无法确认登录状态，请在终端运行 codex login status',
  }
}

module.exports = { checkCodex, checkCommand }
