/*
 * 把新打包的便携版同步到装机版 E:\Harbor（真机反馈 17 批后半 → 1.24.0）
 *
 * 三条纪律（之前的坑都在这三条上）：
 *   ① Harbor 在跑就别动 —— 锁着的文件 robocopy 会报错，而且用户正在用；
 *   ② 同步前把装机版的 data/ 备份走 —— 出问题能退回来；
 *   ③ **两边的 data 都不参与同步**（/MIR 会删目标里多出来的东西，
 *      老装机里那些会话/记忆不能拿来当"多出来的"删掉）。
 * 最后核对：装机版 package.json 的版本 + data 指纹（文件数/字节/最新 mtime）前后一致。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'E:\\CodexWorkbench\\dist-portable\\Harbor'
const DST = 'E:\\Harbor'
const SRC_DATA = join(SRC, 'data')
const DST_DATA = join(DST, 'data')
const REPORT = 'tmp/sync-harbor.txt'

const log = []
const say = (line) => {
  log.push(line)
  console.log(line)
}

/** 数据指纹：文件数 / 总字节 / 最新 mtime（用来证明"同步没碰数据"） */
function fingerprint(dir) {
  if (!existsSync(dir)) return { files: 0, bytes: 0, newest: 0 }
  let files = 0
  let bytes = 0
  let newest = 0
  const walk = (at) => {
    for (const item of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, item.name)
      if (item.isDirectory()) walk(full)
      else {
        const stat = statSync(full)
        files += 1
        bytes += stat.size
        newest = Math.max(newest, stat.mtimeMs)
      }
    }
  }
  walk(dir)
  return { files, bytes, newest: Math.round(newest) }
}

const fmt = (fp) => `${fp.files} 个文件 / ${fp.bytes} 字节 / 最新 ${new Date(fp.newest).toLocaleString('zh-CN')}`

/* ① Harbor 在跑吗 */
const list = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Harbor.exe', '/NH'], { encoding: 'utf8' })
if (String(list.stdout ?? '').includes('Harbor.exe')) {
  say('❌ Harbor 正在运行 —— 先把它完全关掉（含托盘）再跑这个脚本')
  writeFileSync(REPORT, log.join('\n'), 'utf8')
  process.exit(1)
}
say('✅ Harbor 没在运行')

if (!existsSync(SRC)) {
  say(`❌ 找不到打包产物：${SRC}（先 npm run package）`)
  writeFileSync(REPORT, log.join('\n'), 'utf8')
  process.exit(1)
}

/* ② 备份装机版的 data */
const before = fingerprint(DST_DATA)
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = join('E:\\CodexWorkbench\\backups', `data-Harbor-${stamp}`)
if (existsSync(DST_DATA)) {
  mkdirSync(backup, { recursive: true })
  cpSync(DST_DATA, backup, { recursive: true })
  say(`✅ 备份装机版 data → ${backup}`)
} else {
  say('（装机版还没有 data，跳过备份）')
}
say(`   同步前 data 指纹：${fmt(before)}`)

/* ③ robocopy /MIR，两边 data 都排除 */
const copy = spawnSync(
  'robocopy',
  [SRC, DST, '/MIR', '/XD', SRC_DATA, DST_DATA, '/NFL', '/NDL', '/NJH', '/NP', '/R:2', '/W:1'],
  { encoding: 'utf8' },
)
const code = copy.status ?? -1
say(`robocopy 退出码 ${code}（<8 算成功）`)
if (code >= 8) {
  say(String(copy.stdout ?? '').slice(-1500))
  writeFileSync(REPORT, log.join('\n'), 'utf8')
  process.exit(1)
}

/* ④ 核对 */
const installed = JSON.parse(readFileSync(join(DST, 'resources', 'app', 'package.json'), 'utf8'))
const after = fingerprint(DST_DATA)
say(`✅ 装机版版本：${installed.version}`)
say(`${after.files === before.files && after.bytes === before.bytes ? '✅' : '❌'} data 指纹：${fmt(after)}`)
say(
  after.files === before.files && after.bytes === before.bytes
    ? '✅ 同步没有碰用户数据'
    : '❌ 数据指纹变了 —— 别用，先去 backups 里找回来',
)
const exe = join(DST, 'Harbor.exe')
say(`${existsSync(exe) ? '✅' : '❌'} 主程序在位：${exe}`)
writeFileSync(REPORT, log.join('\n'), 'utf8')
