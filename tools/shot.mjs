/**
 * CDP 截图工具
 *
 * 为什么需要它：`chrome --screenshot` 只能截初始状态，点不了按钮。
 * 这个脚本用 DevTools Protocol 连上 Chrome，可以先执行一段 JS
 * （切主题、开弹窗、点标签），再截图。
 *
 * 用法：
 *   node tools/shot.mjs                       # 默认截一组
 *   node tools/shot.mjs --url=http://... --out=shots
 *
 * 前置：Chrome 已经带着 --remote-debugging-port 在跑（脚本会自己起）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchChrome, waitForDevtools, connect, sleep } from './shot/cdp.mjs'
import { SHOTS } from './shot/scenarios.mjs'

const PORT = Number(process.env.CDP_PORT ?? 9334)
const BASE_URL =
  process.argv.find((a) => a.startsWith('--url='))?.slice(6) ?? 'http://localhost:4273/'
const OUT_DIR = resolve(process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'shots')
const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

mkdirSync(OUT_DIR, { recursive: true })

/* ── 3. 截图流程 ──────────────────────────────────────────── */

/** 一连串动作：{ name, script } —— script 在页面里执行 */

async function main() {
  const chrome = launchChrome({ chromePath: CHROME, port: PORT })
  const results = []
  try {
    await waitForDevtools(PORT)
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (!page) throw new Error('没有可用的 page target')

    const cdp = await connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url: BASE_URL })
    await sleep(3500)

    for (const shot of SHOTS) {
      if (shot.script) {
        try {
          await cdp.send('Runtime.evaluate', { expression: shot.script, awaitPromise: false })
        } catch (err) {
          results.push(`${shot.name}: 动作失败 ${err.message}`)
        }
        await sleep(900)
      }
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(resolve(OUT_DIR, `${shot.name}.png`), Buffer.from(data, 'base64'))
      console.log(`  截图 ${shot.name}`)
    }
  } finally {
    chrome.kill()
  }
  if (results.length) console.log(results.join('\n'))
}

main().catch((err) => {
  console.error('失败：', err.message)
  process.exit(1)
})
