/*
 * 发版收口：push main → 打 tag → push tag → 建 Release + 上传 zip。
 *
 * 为什么全在一个脚本里：这个终端的输出既滞后又会被截断（20KB 就落文件），
 * 而发版每一步都要求「确认了才往下走」。全部走 spawnSync，结论写到 tmp/do-release.txt。
 *
 * 上传那一步要过代理（GitHub 直连不通）：Node 24 的 fetch 认 NODE_USE_ENV_PROXY=1 +
 * HTTPS_PROXY —— 所以由**这里**把环境变量给它，不改 upload 脚本本身。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'E:\\CodexWorkbench'
const GIT = 'E:\\Git\\cmd\\git.exe'
const PROXY = 'http://127.0.0.1:10808'
const TAG = 'v1.29.0'
const lines = []
const say = (line) => {
  lines.push(line)
  console.log(line)
}

const run = (cmd, args, options = {}) =>
  spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
const tail = (result, n = 6) =>
  `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-n).join('\n')
const git = (args, options) => run(GIT, ['-c', `http.proxy=${PROXY}`, ...args], options)

/* ① push main（pre-push 会跑全链，几分钟） */
const push = git(['push', 'origin', 'main'])
say(`① push main exit=${push.status}`)
say(tail(push))
say(`① 远端 main：${git(['log', '--oneline', '-1', 'origin/main']).stdout?.trim()}`)

/* ② tag（本地没有才打），然后推 tag */
if (!git(['tag', '-l', TAG]).stdout?.trim()) {
  const made = git(['tag', '-a', TAG, '-m', `Harbor ${TAG.slice(1)}`])
  say(`② 打 tag exit=${made.status} ${tail(made, 2)}`)
} else {
  say(`② tag ${TAG} 已存在`)
}
const tagPush = git(['push', 'origin', TAG])
say(`② push tag exit=${tagPush.status}`)
say(tail(tagPush, 4))

/* ③ 建 Release + 上传 zip（正式版；要 beta 就加 --beta） */
const upload = run('node', ['scripts/release-upload.mjs'], {
  env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY },
})
say(`③ release:upload exit=${upload.status}`)
say(tail(upload, 14))

writeFileSync(join(REPO, 'tmp', 'do-release.txt'), lines.join('\n'), 'utf8')
console.log(`—— 报告写到 tmp/do-release.txt（zip 在：${existsSync(join(REPO, 'dist-portable', 'harbor-1.29.0-win-x64.zip'))}）——`)
