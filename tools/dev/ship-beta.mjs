/*
 * 把当前版本装进 E:\Harbor（用户的日常环境），并在动手前把状态说清。
 *
 * 为什么先检查 Harbor.exe：`npm run package` 第一步会 `taskkill /F /IM Harbor.exe`
 * —— 用户正开着的话会被直接杀掉（docs/发布检查.md 里写着「打包前先关掉正在用的那个」）。
 * 所以这里**不擅自杀**：它在跑就停手并说清，等人关掉再跑。
 *
 * 同步口径与之前一致：dist-portable/Harbor → E:\Harbor，**跳过顶层 data/**
 * （会话、审计、密钥都不能被产物覆盖）。
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'E:\\CodexWorkbench'
const GIT = 'E:\\Git\\cmd\\git.exe'
const PROXY = 'http://127.0.0.1:10808'
const DIST = join(REPO, 'dist-portable', 'Harbor')
const INSTALLED = 'E:\\Harbor'
const lines = []
const say = (line) => {
  lines.push(line)
  console.log(line)
}

const run = (cmd, args, options = {}) =>
  spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
const git = (args) => run(GIT, ['-c', `http.proxy=${PROXY}`, ...args])
const versionOf = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, 'resources', 'app', 'package.json'), 'utf8')).version
  } catch {
    return '（读不到）'
  }
}

/* ① 确认推送（已经在远端就是 up-to-date，安全） */
const push = git(['push', 'origin', 'main'])
const head = (git(['log', '--oneline', '-1']).stdout ?? '').trim()
const remote = (git(['log', '--oneline', '-1', 'origin/main']).stdout ?? '').trim()
say(`① push exit=${push.status}`)
say(`① 本地 ${head}`)
say(`① 远端 ${remote}`)
if (head !== remote) {
  /* 远端引用可能滞后：fetch 一下再比 */
  git(['fetch', 'origin', 'main'])
  const fetched = (git(['log', '--oneline', '-1', 'origin/main']).stdout ?? '').trim()
  say(`① fetch 之后远端 ${fetched}`)
}

/* ② 应用在跑就先停手（不擅自杀它） */
const tasks = run('tasklist', ['/FI', 'IMAGENAME eq Harbor.exe'])
const running = /Harbor\.exe/i.test(tasks.stdout ?? '')
if (running) {
  say('② ✗ Harbor.exe 正在运行 —— 打包会把它杀掉，所以停手。请先关掉 E:\\Harbor 里那个应用，再让我跑一次。')
  writeFileSync(join(REPO, 'tmp', 'ship-beta.txt'), lines.join('\n'), 'utf8')
  process.exit(1)
}
say('② Harbor.exe 没在跑，可以打包')

/* ③ 打包 */
const pack = run('npm.cmd', ['run', 'package'], { shell: true })
say(`③ package exit=${pack.status}`)
if (pack.status !== 0) {
  say(`${(pack.stdout ?? '').slice(-800)}\n${(pack.stderr ?? '').slice(-400)}`)
  writeFileSync(join(REPO, 'tmp', 'ship-beta.txt'), lines.join('\n'), 'utf8')
  process.exit(1)
}
say(`③ 产物版本 ${versionOf(DIST)}（package.json 是 ${JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version}）`)

/* ④ 同步：跳过顶层 data/ */
let copied = 0
for (const name of readdirSync(DIST)) {
  if (name.toLowerCase() === 'data') continue
  const src = join(DIST, name)
  const dst = join(INSTALLED, name)
  if (statSync(src).isDirectory()) {
    rmSync(dst, { recursive: true, force: true })
    cpSync(src, dst, { recursive: true })
  } else {
    cpSync(src, dst)
  }
  copied += 1
}
say(`④ 同步 ${copied} 项 → E:\\Harbor 现在 ${versionOf(INSTALLED)}`)
say(`④ data\\sessions 还在：${existsSync(join(INSTALLED, 'data', 'sessions'))}`)

writeFileSync(join(REPO, 'tmp', 'ship-beta.txt'), lines.join('\n'), 'utf8')
