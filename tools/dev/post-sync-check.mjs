/*
 * 同步之后的收尾核对：
 *   ① 跑装机版自己的 --self-test（**加了几条 IPC 通道时最容易出事的就是它** ——
 *      EXPECTED_CHANNELS 没同步会报 channelsMissing，而那是窗口照开、只弹一个错误框的坑）；
 *   ② 看一眼默认对话目录的现状（data/workspace 有没有东西、data/chat 建了没）——
 *      这决定用户升级之后"文件在哪"，得能提前说清楚。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const exe = 'E:\\Harbor\\Harbor.exe'
const out = []

/* 直接起 exe（不要再套一层 cmd —— 引号会被吃掉，报「不是内部或外部命令」） */
const run = spawnSync(exe, ['--self-test'], {
  encoding: 'utf8',
  cwd: 'E:\\Harbor',
  timeout: 180000,
  maxBuffer: 1e9,
})
out.push(`交付物自检退出码：${run.status}`)
const raw = String(run.stdout ?? '').trim()
if (!raw) {
  out.push('（没读到输出 —— GUI 子系统不往终端回 stdout，但退出码 0 也算过了）')
} else {
  try {
    const json = JSON.parse(raw.slice(raw.indexOf('{')))
    out.push(`版本：${json.version ?? '?'}`)
    out.push(`通道：期望 ${json.channelsExpected ?? '?'} · 实际 ${json.channelsActual ?? '?'}`)
    out.push(`缺通道：${JSON.stringify(json.channelsMissing ?? [])}`)
    out.push(`多余通道：${JSON.stringify(json.channelsExtra ?? [])}`)
    out.push(`其他失败：${JSON.stringify(json.failed ?? json.failures ?? [])}`)
  } catch {
    out.push(raw.slice(0, 1200))
  }
}

const count = (dir) => {
  try {
    return readdirSync(dir).length
  } catch {
    return '（不存在）'
  }
}
out.push(`装机版 data/workspace：${count('E:\\Harbor\\data\\workspace')} 个条目`)
out.push(`装机版 data/chat：${count('E:\\Harbor\\data\\chat')} 个条目`)

const report = out.join('\n')
writeFileSync('tmp/post-sync-check.txt', report, 'utf8')
console.log(report)
