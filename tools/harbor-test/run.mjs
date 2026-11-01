import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { ROOT } from './manifest.mjs'

const require = createRequire(import.meta.url)
const { redact } = require('../../electron/core/redact.cjs')
export const DATA = join(ROOT, 'data', 'harbor-test')

export function hash(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return null }
}

export function makeRunDir() {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid
  const dir = join(DATA, 'runs', id)
  mkdirSync(dir, { recursive: true })
  return { id, dir }
}

export function saveJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export async function runProcess({ file, args = [], cwd = ROOT, env = {}, timeoutMs = 600_000, dir, onLine = () => {} }) {
  mkdirSync(dir, { recursive: true })
  const start = Date.now()
  let stdout = '', stderr = '', timedOut = false, cancelled = false, spawnError = ''
  const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: false })
  const consume = (key) => (chunk) => {
    const value = chunk.toString()
    if (key === 'out') stdout += value
    else stderr += value
    for (const line of value.split(/\r?\n/)) if (line) onLine(redact(line))
  }
  child.stdout?.on('data', consume('out'))
  child.stderr?.on('data', consume('err'))
  child.on('error', (error) => { spawnError = error.message })
  const stopTree = () => {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    else child.kill()
  }
  const onInterrupt = () => { cancelled = true; stopTree() }
  process.once('SIGINT', onInterrupt)
  const timer = setTimeout(() => { timedOut = true; stopTree() }, timeoutMs)
  const exitCode = await new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)))
  clearTimeout(timer)
  process.off('SIGINT', onInterrupt)
  const info = { exitCode, timedOut, cancelled, spawnError: redact(spawnError), durationMs: Date.now() - start }
  writeFileSync(join(dir, 'stdout.log'), redact(stdout), 'utf8')
  writeFileSync(join(dir, 'stderr.log'), redact(stderr), 'utf8')
  saveJson(join(dir, 'exit.json'), info)
  if (exitCode !== 0 || timedOut || cancelled) collectEvidence(dir, start)
  return { ...info, output: redact(stdout + '\n' + stderr) }
}

function collectEvidence(dir, since) {
  const evidence = join(dir, 'evidence')
  mkdirSync(evidence, { recursive: true })
  const logs = join(ROOT, 'data', 'unit-test-data', 'logs')
  const captured = []
  if (existsSync(logs)) {
    for (const name of readdirSync(logs).filter((x) => /\.(log|jsonl)$/i.test(x)).slice(0, 30)) {
      const file = join(logs, name)
      try {
        if (statSync(file).mtimeMs < since - 1000) continue
        writeFileSync(join(evidence, name + '.tail.txt'), redact(readFileSync(file, 'utf8').slice(-50_000)), 'utf8')
        captured.push(name)
      } catch { /* 单个诊断文件坏了不影响原始退出码 */ }
    }
  }
  saveJson(join(evidence, 'capture.json'), {
    logs: captured, screenshot: 'notCaptured', domSnapshot: 'notCaptured',
    reason: '现有脚本若未自行保存截图或 DOM，第一批运行器不能在进程退出后补造现场',
  })
}

export function npmSpec(name) {
  if (process.platform === 'win32') {
    const cli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(cli)) return { file: process.execPath, args: [cli, 'run', name] }
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `npm run ${name}`] }
  }
  return { file: 'npm', args: ['run', name] }
}

export function copyInstalled(target, runDir) {
  const dest = join(runDir, 'installed-copy')
  const sourceExe = join(target.path, 'Harbor.exe')
  const sourceHash = hash(sourceExe)
  if (!sourceHash) throw new Error('无法读取安装版 Harbor.exe')
  cpSync(target.path, dest, {
    recursive: true,
    filter: (src) => {
      const rel = relative(target.path, src)
      return !rel || (rel !== 'data' && !rel.startsWith(`data\\`) && !rel.startsWith('data/'))
    },
  })
  const copiedExe = join(dest, 'Harbor.exe')
  if (!existsSync(copiedExe) || hash(copiedExe) !== sourceHash) throw new Error('安装版副本哈希校验失败')
  return { exe: copiedExe, sourceHash, copy: dest }
}

export function acquireLock() {
  mkdirSync(DATA, { recursive: true })
  const file = join(DATA, 'runner.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' })
      return () => { try { if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file) } catch { /* 退出时尽力清理 */ } }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let old
      try { old = Number(readFileSync(file, 'utf8')) } catch { old = null }
      if (old > 0) {
        try { process.kill(old, 0); throw new Error(`已有测试运行器在运行（PID ${old}）`) } catch (e) {
          if (e?.code !== 'ESRCH') throw e
        }
      }
      if (attempt === 0) try { unlinkSync(file) } catch { /* 竞争者可能已移除 */ }
    }
  }
  throw new Error('测试队列锁竞争，稍后重试')
}
