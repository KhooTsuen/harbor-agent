/**
 * 真机验收的「脚手架」：隔离数据 → 起假上游 → 起源码树 Electron → 连 CDP。
 *
 * 从 `tools/e2e-process-live.mjs` 抽出来的原因：那边还要跑「停止 / 失败」两个场景，
 * 样板留在主脚本里就贴 300 行红线了。抽出来的都是**与判据无关**的东西，
 * 判据仍然写在主脚本里（哪儿错了要一眼能看见）。
 *
 * ★ 隔离：`HARBOR_UNIT_TEST=1` → 数据根 `data/unit-test-data`，完全不碰仓库真 data。
 *   跑完把 config / credentials 原样写回（哪怕只是临时改过 baseUrl）。
 * ★ 假上游按**请求体**分派：主对话（带 `tools`）走场景行为，场景请求（title / suggest）
 *   一律给一句普通正文 —— 按次数排队会把工具调用发给 title 场景（踩过）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from './shot/cdp.mjs'
import { respond, replyScene, isMainChat } from './live-fake-upstream.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ISO = resolve(ROOT, 'data', 'unit-test-data')
const CONF = resolve(ISO, 'config.json')
const CRED = resolve(ISO, 'credentials.json')
const SHOT_DIR = resolve(ROOT, 'shots', 'electron')
const PORT = 9381
const FAKE_PORT = 9971

/**
 * 起一整套：假上游 + Electron + CDP。调用方拿到 `ev` / `shotTo` / `waitFor` / `rec`。
 *
 * @param {object} [opts]
 * @param {'slow'|'error'} [opts.mode] 主对话的初始行为（可在跑的过程中改）
 * @param {number} [opts.pace] 每片正文间隔（毫秒）
 * @param {number} [opts.pieces] 一共几片
 */
export async function start({ mode = 'slow', pace = 1400, pieces = 8 } = {}) {
  mkdirSync(ISO, { recursive: true })
  const confBackup = existsSync(CONF) ? readFileSync(CONF, 'utf8') : null
  const credBackup = existsSync(CRED) ? readFileSync(CRED, 'utf8') : null
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
  cfg.providers[0].baseUrl = `http://127.0.0.1:${FAKE_PORT}/v1`
  writeFileSync(CONF, JSON.stringify(cfg, null, 2))
  writeFileSync(
    CRED,
    JSON.stringify(
      {
        version: 1,
        backend: 'plain',
        entries: { [cfg.providers[0].credentialRef]: { value: 'sk-e2e', updatedAt: Date.now() } },
      },
      null,
      2,
    ),
  )
  const restoreData = () => {
    try {
      if (confBackup === null) rmSync(CONF, { force: true })
      else writeFileSync(CONF, confBackup)
      if (credBackup === null) rmSync(CRED, { force: true })
      else writeFileSync(CRED, credBackup)
    } catch {
      /* ignore */
    }
  }

  let current = { mode, pace, pieces }
  let mainRound = 0
  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      /* 主对话的请求体带 tools；title / suggest 这类场景请求不带 */
      if (!/"tools"/.test(body)) {
        replyScene(res)
        return
      }
      mainRound += 1
      respond(res, current.mode, current.pace, current.pieces, mainRound)
    })
  })
  await new Promise((ok) => upstream.listen(FAKE_PORT, '127.0.0.1', ok))

  const app = spawn(BIN, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HARBOR_UNIT_TEST: '1' },
  })
  const killApp = () =>
    spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  let appLog = ''
  app.stdout.on('data', (b) => (appLog += b.toString()))
  app.stderr.on('data', (b) => (appLog += b.toString()))

  const results = []
  const rec = (name, pass, detail) => {
    results.push({ name, pass })
    console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`)
  }

  let cdp
  let log = ''
  try {
    await sleep(1500)
    const target = await findPageTarget(PORT, { timeoutMs: 45000 })
    cdp = await connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
  } catch (error) {
    killApp()
    upstream.close()
    restoreData()
    throw error
  }

  /** 在页面里执行一段表达式（结果顺手记进日志，出错时能回看当时 DOM 是什么样） */
  const ev = async (expr, label) => {
    const v = await evaluate(cdp, expr, { label })
    log += `${label}: ${JSON.stringify(v)}\n`
    return v
  }

  /** 截图。给了 rect 就只截那一块并放大 4 倍（入口那 4 个字在全屏图里看不清高光） */
  const shotTo = async (file, rect) => {
    mkdirSync(SHOT_DIR, { recursive: true })
    const params = { format: 'png' }
    if (rect) {
      const pad = 6
      params.clip = {
        x: Math.max(0, rect.x - pad),
        y: Math.max(0, rect.y - pad),
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        scale: 4,
      }
    }
    const shot = await cdp.send('Page.captureScreenshot', params)
    writeFileSync(resolve(SHOT_DIR, file), Buffer.from(shot.data, 'base64'))
    console.log(`  截图 → ${resolve(SHOT_DIR, file)}`)
  }

  /** 反复采样直到 pred 成立（超时就把最后一次采样返回，别抛） */
  const waitFor = async (expr, pred, ms, label) => {
    const deadline = Date.now() + ms
    let last = null
    while (Date.now() < deadline) {
      last = await ev(expr, label)
      if (pred(last)) return last
      await sleep(300)
    }
    return last
  }

  /** 等界面出现输入框（启动期的固定等待，别用死的 sleep） */
  const waitReady = async () => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await ev(`!!document.querySelector('textarea')`, '等输入框')) return true
      await sleep(500)
    }
    return false
  }

  /** 改主对话的行为（下一个请求生效） */
  const setMode = (next) => {
    /*
     * 换模式 = 换一个场景 → 轮次从 1 重新数。
     * 不重置的话，第二个场景的第 1 轮会被当成第 N 轮（按轮次发工具的剧本全错位，
     * 判据看到的是「上一场景的尾巴」，却照样打印成绿）。
     */
    if (next.mode && next.mode !== current.mode) mainRound = 0
    current = {
      ...current,
      mode: next.mode ?? current.mode,
      pace: next.pace ?? current.pace,
      pieces: next.pieces ?? current.pieces,
    }
  }

  /** 刷新页面（等于关掉再打开一次，用来验「重开历史」） */
  const reload = () => cdp.send('Page.reload')

  /** 模拟系统「减少动态」（CDP 的媒体特性仿真，不是改真实系统设置） */
  const emulateReduce = () =>
    cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
  const clearEmulation = () => cdp.send('Emulation.setEmulatedMedia', { features: [] })

  const close = () => {
    try {
      writeFileSync(resolve(SHOT_DIR, 'process-live-probe.log'), log + appLog)
    } catch {
      /* ignore */
    }
    try {
      cdp?.ws.close()
    } catch {
      /* ignore */
    }
    killApp()
    upstream.close()
    restoreData()
  }

  return {
    ev,
    shotTo,
    waitFor,
    waitReady,
    setMode,
    rec,
    results,
    close,
    reload,
    emulateReduce,
    clearEmulation,
  }
}
