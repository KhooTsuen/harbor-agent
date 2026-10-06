/*
 * 发版前的状态一眼看完：本地提交 / 远端同步 / tag / 发布 zip。
 *
 * 为什么写脚本：这个终端的输出既滞后又会被截断（20KB 一到就落文件），
 * 发版这种「每一步都要确认」的事不能靠它。结论写到 tmp/release-state.txt。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const REPO = 'E:\\CodexWorkbench'
const GIT = 'E:\\Git\\cmd\\git.exe'
const PROXY = 'http://127.0.0.1:10808'
const lines = []
const say = (line) => {
  lines.push(line)
  console.log(line)
}

const run = (cmd, args, options = {}) =>
  spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })

const git = (args) => (run(GIT, ['-c', `http.proxy=${PROXY}`, ...args]).stdout ?? '').trim()

say(`本地 HEAD：${git(['log', '--oneline', '-1'])}`)
say(`远端 main：${git(['log', '--oneline', '-1', 'origin/main'])}`)
say(`状态：${git(['status', '-sb']).split('\n')[0]}`)
say(`本地 tag：${git(['tag', '-l']).replace(/\n/g, ' ') || '（无）'}`)
say(`远端 tag：${(git(['ls-remote', '--tags', 'origin']).match(/refs\/tags\/[^\s^]+/g) ?? []).join(' ') || '（无）'}`)

const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
const zip = join(REPO, 'dist-portable', `harbor-${version}-win-x64.zip`)
say(`package.json：${version}`)

if (!existsSync(zip)) {
  say('zip 不存在 —— 现打一个')
  const res = run('node', ['scripts/release-zip.mjs'])
  say(`${(res.stdout ?? '').trim().split('\n').slice(-3).join('\n')}`)
  say(`release-zip exit=${res.status}`)
}
say(existsSync(zip) ? `zip：${Math.round(statSync(zip).size / 1048576)}MB ✓` : 'zip：还是没打出来 ✗')

writeFileSync(join(REPO, 'tmp', 'release-state.txt'), lines.join('\n'), 'utf8')
