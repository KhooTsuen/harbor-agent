/*
 * 只看不写：本地 ↔ 远端（GitHub）有没有对不上的地方。
 *
 * 为什么用脚本：这个终端会把「一串命令里的第一条」吞掉，git 的短选项也会被拆。
 * 全部走 spawnSync + 代理，输出写到 tmp/github.txt。
 *
 * 检查项：
 *   · 本地/远端是否分叉（ahead / behind）
 *   · 远端还有哪些分支（别的分支上有没有没并回 main 的活）
 *   · 标签 / Release 有没有（版本已经到 1.29.0，tag 呢）
 *   · 有没有 gh CLI（有就能问 issue / PR / Actions）
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const REPO = 'E:\\CodexWorkbench'
const GIT = 'E:\\Git\\cmd\\git.exe'
const PROXY = 'http://127.0.0.1:10808'
const lines = []
const say = (line) => {
  lines.push(line)
  console.log(line)
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return { status: result.status, text }
}

function git(args, label) {
  const { status, text } = run(GIT, ['-c', `http.proxy=${PROXY}`, ...args])
  say(`—— ${label}（exit=${status}）——`)
  say(text || '（空）')
  return text
}

git(['fetch', 'origin', '--prune', '--tags'], 'fetch origin')
git(['status', '-sb'], '本地状态')
git(['log', '--oneline', '-3', 'origin/main'], '远端 main 最近三条')
git(['log', '--oneline', 'HEAD..origin/main'], '远端有、本地没有的提交')
git(['log', '--oneline', 'origin/main..HEAD'], '本地有、远端没有的提交')
git(['branch', '-r'], '远端分支')
git(['tag', '-l'], '本地标签')
git(['ls-remote', '--tags', 'origin'], '远端标签')

const gh = run('gh', ['--version'])
say(`—— gh CLI（exit=${gh.status}）——`)
say(gh.text.split('\n')[0] || '（没装 / 不在 PATH）')

if (gh.status === 0) {
  const issues = run('gh', ['issue', 'list', '--limit', '30', '--state', 'open'])
  say('—— 打开的 issue ——')
  say(issues.text || '（没有，或读不到）')

  const prs = run('gh', ['pr', 'list', '--limit', '30', '--state', 'open'])
  say('—— 打开的 PR ——')
  say(prs.text || '（没有，或读不到）')

  const runs = run('gh', ['run', 'list', '--limit', '8'])
  say('—— 最近 8 次 Actions ——')
  say(runs.text || '（没有，或读不到）')

  const releases = run('gh', ['release', 'list', '--limit', '8'])
  say('—— Release ——')
  say(releases.text || '（一个都没有）')
}

writeFileSync(`${REPO}\\tmp\\github.txt`, lines.join('\n'), 'utf8')
console.log('—— 全部写到 tmp/github.txt ——')
