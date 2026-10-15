/**
 * Phase 0 · 步骤 A v2：让 Edge 真的加载 unpacked 扩展。
 *
 * 背景：Chromium 137 起用 feature 开关 `DisableLoadExtensionCommandLineSwitch`
 * 把 `--load-extension` 关掉了 —— 所以「传了但不生效」是预期行为，
 * 要显式用 `--disable-features=...` 关掉那个开关。
 *
 * 同时本地**算出**扩展 ID（unpacked 扩展的 ID = sha256(绝对路径) 前 16 字节，
 * 每个字节取高 4 位映射到 a–p）—— 这样即使 Edge 不告诉我们也能填 allowed_origins。
 */
const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'E:\\CodexWorkbench\\harbor-edge\\phase0'
const PROFILE = path.join(BASE, 'edge-profile2')
const EXT = path.join(BASE, 'ext')

/** unpacked 扩展 ID 的算法（Chromium 的 crx_file::id_util::GenerateIdForPath） */
function idForPath(p) {
  const digest = crypto.createHash('sha256').update(p, 'utf8').digest()
  return Array.from(digest.subarray(0, 16))
    .map((b) => String.fromCharCode(97 + (b >> 4)))
    .join('')
}

const LOCAL_ID = idForPath(EXT)
console.log(`本地算出的扩展 ID = ${LOCAL_ID}`)
fs.writeFileSync(path.join(BASE, 'ext-id-computed.txt'), LOCAL_ID)

fs.mkdirSync(PROFILE, { recursive: true })

const child = spawn(
  EDGE,
  [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--remote-debugging-port=9412',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  console.log(`Edge PID=${child.pid}，等扩展装好…`)
  await sleep(10000)

  for (const f of ['Default/Secure Preferences', 'Default/Preferences']) {
    const full = path.join(PROFILE, f)
    if (!fs.existsSync(full)) {
      console.log(`  ${f} —— 不存在`)
      continue
    }
    let j
    try {
      j = JSON.parse(fs.readFileSync(full, 'utf8'))
    } catch (e) {
      console.log(`  ${f} —— 解析失败 ${e.message}`)
      continue
    }
    const s = j?.extensions?.settings ?? {}
    const keys = Object.keys(s)
    console.log(`\n=== ${f}：${keys.length} 个扩展 ===`)
    for (const id of keys) {
      const name = s[id]?.manifest?.name ?? '?'
      const p = s[id]?.path ?? ''
      const ours = p.toLowerCase().includes('harbor-edge')
      console.log(`  ${id}  ${name}  path=${p.slice(0, 70)}${ours ? '   ★ 这是我们加载的' : ''}`)
    }
    if (keys.includes(LOCAL_ID)) {
      console.log(`  ★★ 本地算的 ID ${LOCAL_ID} 出现在里面 —— 扩展加载成功`)
    }
  }
}

run()
  .catch((e) => console.log('ERR', e.message))
  .finally(async () => {
    await sleep(500)
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    console.log('\n已关闭探针 Edge 实例')
  })
