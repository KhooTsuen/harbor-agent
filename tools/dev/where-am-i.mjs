/*
 * 「我现在在哪」——改完一轮之后先问一遍，别凭记忆下结论。
 *   ① 工作区还剩什么没提交
 *   ② 最近三笔提交
 *   ③ 服务器上的 main 是哪个（本地的说法不算数）
 *   ④ 装机版 E:\Harbor 的版本 + 有没有新版的核心文件
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd: 'E:\\CodexWorkbench', env: { ...process.env, GIT_PAGER: 'cat' } }).trim()
  } catch (e) {
    return `（失败：${e.status}）${String(e.stdout ?? e.stderr ?? '').slice(0, 300)}`
  }
}
const remoteGit = (args) =>
  git(['-c', 'http.proxy=http://127.0.0.1:10808', ...args])

const out = []
out.push('── 工作区（未提交）──')
out.push(git(['status', '--short']) || '（干净）')
out.push('── 最近三笔 ──')
out.push(git(['log', '-3', '--format=%h %ad %s', '--date=format:%H:%M']))
out.push('── 本地 HEAD ──')
out.push(git(['rev-parse', 'HEAD']))
out.push('── 服务器 main ──')
out.push(remoteGit(['ls-remote', 'origin', 'refs/heads/main']))
out.push('── 装机版 E:\\Harbor ──')
const pkg = 'E:\\Harbor\\resources\\app\\package.json'
out.push(existsSync(pkg) ? `版本 ${JSON.parse(readFileSync(pkg, 'utf8')).version}` : '（找不到装机版）')
/* 新版才有的文件：有它就说明装机版确实拿到了这一轮 */
const marks = [
  ['浏览器多标签（BrowserTab）', 'E:\\Harbor\\resources\\app\\dist\\assets'],
]
for (const [label, dir] of marks) out.push(`${label}：${existsSync(dir) ? '在' : '缺'}`)

const report = out.join('\n')
writeFileSync('tmp/where-am-i.txt', report, 'utf8')
console.log(report)
