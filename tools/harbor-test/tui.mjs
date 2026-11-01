import { stdout, stdin } from 'node:process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function canTui(plain = false) { return !plain && Boolean(stdout.isTTY && stdin.isTTY && stdin.setRawMode) }

export async function choose() {
  if (!canTui()) return null
  const suites = ['unit', 'self', 'e2e', 'all']
  const targets = ['source', 'installed']
  let i = 0, j = 0
  const draw = () => {
    stdout.write('\x1b[2J\x1b[H')
    stdout.write('Harbor 测试台  ·  方向键选择，Enter 开始，q 退出\n\n')
    stdout.write(`测试：${suites.map((s, n) => n === i ? `[${s}]` : s).join('  ')}\n`)
    stdout.write(`目标：${targets.map((s, n) => n === j ? `[${s}]` : s).join('  ')}\n`)
    stdout.write('\nsource 测源码；installed 测 E:\\Harbor 的隔离程序副本。\n')
  }
  draw()
  stdin.setRawMode(true)
  stdin.resume()
  try {
    return await new Promise((resolve) => {
      const key = (b) => {
        const s = b.toString()
        if (s === '\r' || s === '\n') { stdin.off('data', key); resolve({ suite: suites[i], target: targets[j] }) }
        else if (s === 'q' || s === '\x03') { stdin.off('data', key); resolve(null) }
        else if (s === '\x1b[C') { i = (i + 1) % suites.length; draw() }
        else if (s === '\x1b[D') { i = (i + suites.length - 1) % suites.length; draw() }
        else if (s === '\x1b[A' || s === '\x1b[B') { j = 1 - j; draw() }
      }
      stdin.on('data', key)
    })
  } finally { stdin.setRawMode(false); stdin.pause(); stdout.write('\x1b[2J\x1b[H') }
}

export function progress(line, plain = false) {
  if (!canTui(plain)) { stdout.write(line + '\n'); return }
  stdout.write(`\r\x1b[2K${line.slice(0, Math.max(20, (stdout.columns || 80) - 2))}`)
}

export function finishProgress(plain = false) { if (canTui(plain)) stdout.write('\n') }

export function color(status, text, plain = false) {
  if (plain || !stdout.isTTY) return text
  const code = status === 'PASS' ? 32 : status.startsWith('FAIL') ? 31 : 33
  return `\x1b[${code}m${text}\x1b[0m`
}

export async function showReport(md, dir) {
  if (!canTui()) { stdout.write(md + '\n'); return }
  const parts = md.split(/(?=^## \d+\. )/m)
  let page = 0
  const draw = () => {
    const title = page === 0 ? '总览' : `第 ${page} 节 / 6`
    const body = (parts[page] ?? '').split('\n').slice(0, Math.max(8, (stdout.rows || 35) - 6)).join('\n')
      .replace(/\bFAIL_ASSERTION\b|\bFAIL_INFRA\b/g, (x) => `\x1b[31m${x}\x1b[0m`)
      .replace(/\bSUSPECT\b|\bNOT_RUN\b|\bNEEDS_HUMAN\b|\bBLOCKED_ENV\b|\bNOT_APPLICABLE\b/g, (x) => `\x1b[33m${x}\x1b[0m`)
      .replace(/\bPASS\b/g, (x) => `\x1b[32m${x}\x1b[0m`)
    stdout.write('\x1b[2J\x1b[H')
    stdout.write(`Harbor 测试台  ·  ${title}\n${'─'.repeat(Math.min(stdout.columns || 70, 70))}\n`)
    stdout.write(body + '\n')
    stdout.write(`\n←/→ 切换章节  ·  l 日志尾部  ·  e 证据路径  ·  q 退出\n`)
  }
  draw()
  stdin.setRawMode(true)
  stdin.resume()
  try {
    await new Promise((resolve) => {
      const key = (b) => {
        const s = b.toString()
        if (s === 'q' || s === '\x03') { stdin.off('data', key); resolve() }
        else if (s === '\x1b[C') { page = Math.min(parts.length - 1, page + 1); draw() }
        else if (s === '\x1b[D') { page = Math.max(0, page - 1); draw() }
        else if (s === 'e') { stdout.write(`\n证据目录：${dir}\n`) }
        else if (s === 'l') {
          const files = readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => join(dir, x.name, 'stdout.log'))
          const file = files.at(-1)
          try { stdout.write(`\n${readFileSync(file, 'utf8').split(/\r?\n/).slice(-12).join('\n')}\n`) }
          catch { stdout.write('\n这一轮没有可看的原始日志。\n') }
        }
      }
      stdin.on('data', key)
    })
  } finally { stdin.setRawMode(false); stdin.pause(); stdout.write('\x1b[2J\x1b[H') }
}
