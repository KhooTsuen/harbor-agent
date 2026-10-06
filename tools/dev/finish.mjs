/*
 * 收尾：确认推送 + 打包 + 把产物同步到已安装版 E:\Harbor
 *
 * 为什么要写成脚本（而不是在终端里连命令）：PowerShell 那层会把
 * 「一连串命令里的第一条」吞掉、还会拆开 `-sb` 这类短选项，折腾了好几轮。
 * 这里全部走 spawnSync，cwd 显式给死，输出只留尾巴。
 *
 * 同步口径：复制 dist-portable/Harbor → E:\Harbor，但**跳过顶层 data/**
 * （那是用户的数据：会话、审计、密钥，不能被产物覆盖）。
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'E:\\CodexWorkbench'
const DIST = join(REPO, 'dist-portable', 'Harbor')
const INSTALLED = 'E:\\Harbor'

const out = []
function say(line) {
  out.push(line)
  console.log(line)
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: REPO,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  })
}

function versionOf(root) {
  const file = join(root, 'resources', 'app', 'package.json')
  if (!existsSync(file)) return '（读不到）'
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version
  } catch {
    return '（解析失败）'
  }
}

/* ── ① 推送（已经推过的话这条是 up-to-date，安全） ── */
const push = sh('E:\\Git\\cmd\\git.exe', [
  '-c',
  'http.proxy=http://127.0.0.1:10808',
  'push',
  'origin',
  'main',
])
const pushTail = `${push.stdout ?? ''}${push.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n')
say(`① push exit=${push.status}`)
say(pushTail || '（没有输出）')

const status = sh('E:\\Git\\cmd\\git.exe', ['status', '-sb'])
say(`① status: ${(status.stdout ?? '').trim() || (status.stderr ?? '').trim()}`)

/* ── ② 打包（产物已经是这个版本就跳过，省一次几分钟的构建） ── */
if (versionOf(DIST) !== versionOf(REPO)) {
  const t0 = Date.now()
  const pack = sh('npm.cmd', ['run', 'package'], { shell: true })
  const packTail = `${pack.stdout ?? ''}${pack.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n')
  say(`② package exit=${pack.status}（${Math.round((Date.now() - t0) / 1000)} 秒）`)
  say(packTail || '（没有输出）')
} else {
  say(`② 产物已经是最新的（${versionOf(DIST)}），跳过打包`)
}
say(`② 产物版本：${versionOf(DIST)}`)

/* ── ③ 同步到已安装版（保留它的 data） ── */
function sync(from, to, first = true) {
  let copied = 0
  for (const name of readdirSync(from)) {
    /* 顶层 data/ 是用户数据 —— 从产物覆盖过去等于把人家的会话删了 */
    if (first && name.toLowerCase() === 'data') continue
    const src = join(from, name)
    const dst = join(to, name)
    if (statSync(src).isDirectory()) {
      rmSync(dst, { recursive: true, force: true })
      cpSync(src, dst, { recursive: true })
    } else {
      cpSync(src, dst)
    }
    copied += 1
  }
  return copied
}

const before = versionOf(INSTALLED)
const copied = sync(DIST, INSTALLED)
say(`③ 同步了 ${copied} 项：${before} → ${versionOf(INSTALLED)}`)

/* 会话数据还在吗（同步只该跳过它，不该动它） */
const sessions = join(INSTALLED, 'data', 'sessions')
say(`③ E:\\Harbor\\data\\sessions 还在：${existsSync(sessions)}`)

const report = out.join('\n')
writeFileSync(join(REPO, 'tmp', 'finish.txt'), report, 'utf8')
console.log('—— 报告已写到 tmp/finish.txt ——')
