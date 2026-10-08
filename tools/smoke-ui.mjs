/**
 * UI 冒烟入口：假上游 + 真机，跑几条场景判「测试全绿 ≠ 能用」那些老事故有没有复发
 *
 * 为什么要它：项目吃过三次「测试全绿 ≠ 能用」的事故（见 `smoke/scenarios.mjs`），
 * 三次都过了 tsc + lint + 全部单测。现有真机工具各有门槛：
 *   · `tools/acceptance.mjs`：真机，但**要真凭证 + 真模型**，一轮 180 秒起；
 *   · `tools/break-test-*.mjs`：不要模型，但**直接 require 内核**、不走 UI；
 *   · `tools/shot-electron.mjs`：能连真机，但**只截图、不下判据**。
 * 缺的正是「**假上游 + 真 UI**、几秒出结论」的绊线 —— 就是这个脚本。
 *
 * 它只做编排：配假凭证 / 起假上游 / 逐个场景配 config、交给 `smoke/kit.mjs` 跑。
 * 判据在 `smoke/scenarios.mjs`，起停与 driver 在 `smoke/kit.mjs`（拆开是为了不顶 300 行红线）。
 *
 * 用法：
 *   npm run package                                  # 先有 dist-portable/Harbor/Harbor.exe
 *   node tools/smoke-ui.mjs                          # 跑全部场景
 *   node tools/smoke-ui.mjs --scenarios=confirm      # 只跑确认卡那条
 *   node tools/smoke-ui.mjs --upstream=html          # 自查：强制坏上游，应当报红
 *   node tools/smoke-ui.mjs --keep                   # 跑完不关应用（手动接着看）
 *
 * ⚠ 只碰 dist-portable（构建产物），**不碰安装版 / dev 版的数据**。
 *   跑之前如果有另一个 Harbor 实例在运行，单实例锁会让新进程起不来 —— 会明确报出来。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeCleanup } from './shot/cdp.mjs'
import {
  pointProviderAt,
  runScenario,
  upstreamUrl,
  useFakeCredential,
  waitHttp,
} from './smoke/kit.mjs'
import { SCENARIOS } from './smoke/scenarios.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback

const APP = resolve(ROOT, arg('app', join('dist-portable', 'Harbor')))
const EXE = join(APP, 'Harbor.exe')
const DATA = join(APP, 'data')
const CONFIG = join(DATA, 'config.json')
const CRED = join(DATA, 'credentials.json')
const PORT = Number(arg('port', '9337'))
const FAKE_PORT = Number(arg('fakeport', '9977'))
const KEEP = process.argv.includes('--keep')
/** 自查用：强制所有场景走某一种假上游模式（如 html / empty），应当报红 */
const FORCED = arg('upstream', '')
/** 只跑指定的场景（逗号分隔的 id） */
const ONLY = arg('scenarios', '')

const clean = makeCleanup()
const results = []

/** 假上游只需起一次 —— 一个进程按路径前缀同时支持所有模式 */
function startFakeUpstream() {
  const fake = spawn(process.execPath, [join(ROOT, 'tools', 'fake-upstream.mjs')], {
    env: { ...process.env, FAKE_PORT: String(FAKE_PORT) },
    stdio: 'ignore',
  })
  clean.add(() => fake.kill())
  return fake
}

async function main() {
  if (!existsSync(EXE)) throw new Error(`找不到便携版 ${EXE}，先 npm run package`)
  if (!existsSync(CONFIG)) throw new Error(`找不到 ${CONFIG}（便携版还没配置过）`)

  const scenarios = ONLY
    ? SCENARIOS.filter((s) =>
        ONLY.split(',')
          .map((x) => x.trim())
          .includes(s.id),
      )
    : SCENARIOS
  if (scenarios.length === 0) throw new Error(`没有匹配的场景：${ONLY}`)

  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
  const provider = (cfg.providers ?? [])[0]
  if (!provider) throw new Error('config.providers 是空的，没法指向假上游')
  clean.add(useFakeCredential(CRED, provider.credentialRef))
  console.log(`临时写入假凭证：${provider.credentialRef}（明文后端，跑完删掉；真 key 不经过这里）`)

  startFakeUpstream()
  if (!(await waitHttp(`http://127.0.0.1:${FAKE_PORT}/`, 5000))) {
    throw new Error(`假上游没起来（端口 ${FAKE_PORT} 可能被占）`)
  }

  for (const scenario of scenarios) {
    const mode = FORCED || scenario.upstream
    console.log(`\n▶ 场景「${scenario.id}」${scenario.title} · 假上游模式=${mode}`)
    const { restore } = pointProviderAt(CONFIG, upstreamUrl(FAKE_PORT, mode))
    try {
      await runScenario({
        scenario,
        exe: EXE,
        appDir: APP,
        dataDir: DATA,
        port: PORT,
        keep: KEEP,
        onStep: ({ name, pass, detail }) => {
          results.push({ scenario: scenario.id, name, pass })
          console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
        },
      })
    } finally {
      restore()
    }
  }

  const passed = results.filter((r) => r.pass).length
  const allPass = results.length > 0 && passed === results.length
  console.log(`\n${allPass ? '✅ 冒烟通过' : '❌ 冒烟失败'}（${passed}/${results.length}）`)
  return allPass ? 0 : 1
}

let code = 1
try {
  code = await main()
} catch (error) {
  console.error(`\n!! 冒烟中断：${error instanceof Error ? error.message : error}`)
  code = 1
} finally {
  if (!KEEP) clean.run()
  else console.log('\n（--keep：假上游与假凭证留着，手动关掉即可）')
}
process.exit(code)
