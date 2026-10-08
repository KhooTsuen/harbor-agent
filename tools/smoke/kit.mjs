/**
 * 冒烟工具箱：把应用弄起来、连上 CDP、给场景一个「driver」
 *
 * 场景（`scenarios.mjs`）只管**判据**，不关心应用怎么起、CDP 怎么连 —— 那些都在这。
 * 从 `tools/smoke-ui.mjs` 拆出来的：那边要跑两个场景，塞进一个文件就顶 300 行红线。
 *
 * 判据一律看**磁盘**（会话文件 / 产物文件），不信任界面文本 —— 和 `acceptance.mjs` 一个路子。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, sleep, findPageTarget, evaluate } from '../shot/cdp.mjs'

export { sleep }

/** 假上游的 baseUrl：mode 为 'ok'（默认）时无后缀，其余是 `/v1-<mode>` */
export function upstreamUrl(port, mode) {
  return `http://127.0.0.1:${port}/v1${!mode || mode === 'ok' ? '' : `-${mode}`}`
}

/**
 * 给便携版塞一个**假凭证**。
 *
 * 便携版是构建产物、**没有 key** —— 少它，消息会被应用直接挡回来（「XXX 还没填 API Key」），
 * 走不到模型。用明文的 `backend: 'plain'`：`credentials.cjs` 的 `decrypt()` 按**文件里的
 * backend** 决定解不解密，于是能原样读回（真 key 全程不经过这里）。返回还原函数。
 */
export function useFakeCredential(credPath, ref) {
  const original = existsSync(credPath) ? readFileSync(credPath, 'utf8') : null
  writeFileSync(
    credPath,
    JSON.stringify(
      { version: 1, backend: 'plain', entries: { [ref]: { value: 'sk-smoke', updatedAt: Date.now() } } },
      null,
      2,
    ),
  )
  return () => {
    try {
      if (original === null) rmSync(credPath, { force: true })
      else writeFileSync(credPath, original)
    } catch {
      /* 忽略 */
    }
  }
}

/** 读 config、把 providers[0].baseUrl 指到假上游，返回 { original, provider, restore } */
export function pointProviderAt(configPath, url) {
  const original = readFileSync(configPath, 'utf8')
  const cfg = JSON.parse(original)
  const provider = (cfg.providers ?? [])[0]
  if (!provider) throw new Error('config.providers 是空的，没法指向假上游')
  provider.baseUrl = url
  writeFileSync(configPath, JSON.stringify(cfg, null, 2))
  return { original, provider, restore: () => writeFileSync(configPath, original) }
}

export const listSessions = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []

/** 本轮**新出现**（或最新）的会话文件里，最后一条**完整**的助手回答 */
export function newestAssistant(dir, before) {
  const all = listSessions(dir)
  const fresh = all
    .filter((f) => !before.has(f))
    .sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
  const pick =
    fresh[0] ??
    all.map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0]?.f
  if (!pick) return ''
  for (const line of readFileSync(join(dir, pick), 'utf8').trim().split('\n').reverse()) {
    try {
      const rec = JSON.parse(line)
      if (
        rec.type === 'message' &&
        rec.role === 'assistant' &&
        rec.partial !== true &&
        String(rec.content ?? '').trim()
      ) {
        return String(rec.content)
      }
    } catch {
      /* 坏行跳过 */
    }
  }
  return ''
}

/** 轮询直到 fn 返回真值；超时返回最后一次的结果 */
export async function waitFor(fn, { timeoutMs = 30000, intervalMs = 800 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

export async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(url)
      return true
    } catch {
      await sleep(200)
    }
  }
  return false
}

/* ── UI 原语：选择器抄自 acceptance.mjs（aria-label / title / 文本三处任一命中）── */
const NEW_CHAT = `(function(){const re=/^新建对话/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`
const SEND = `(function(){const re=/发送消息/;const hit=x=>re.test(x.getAttribute('aria-label')||'')||re.test(x.title||'')||re.test((x.textContent||'').trim());const b=[...document.querySelectorAll('button')].find(hit);if(!b)return false;b.click();return true})()`
/* 权限卡是 `PermissionBar.tsx` 的 `section[aria-label="等待确认"]`，按钮「取消 / 允许本次」 */
export const CONFIRM_CARD = `!!document.querySelector('section[aria-label="等待确认"]')`
export const APPROVE = `(function(){const c=document.querySelector('section[aria-label="等待确认"]');if(!c)return false;const b=[...c.querySelectorAll('button')].find(x=>/允许/.test(x.textContent||''));if(!b)return false;b.click();return true})()`

function makeDriver({ scenario, ev, sessionsDir, dataDir, before, onStep }) {
  return {
    id: scenario.id,
    prompt: scenario.prompt,
    sessionsDir,
    dataDir,
    ev,
    sleep,
    waitFor,
    record: (name, pass, detail) => onStep({ name, pass, detail }),
    newConversation: async () => {
      await ev(NEW_CHAT, '新建对话')
      await sleep(1200)
    },
    /** 填输入框 + 点发送，返回 { typed, sent } */
    sendPrompt: async (text) => {
      const typed = await ev(fillExpr(text), '填输入框')
      await sleep(500)
      const sent = await ev(SEND, '点发送')
      return { typed, sent }
    },
    waitAssistant: (timeoutMs = 30000) =>
      waitFor(() => newestAssistant(sessionsDir, before) || '', { timeoutMs }),
  }
}

/**
 * 跑一个场景：起应用 → 连 CDP → 等界面 → scenario.run(driver) → 关应用。
 * 起不来（多半被单实例锁挡住）会抛出带说明的错误。
 */
export async function runScenario({ scenario, exe, appDir, dataDir, port, keep = false, onStep }) {
  const sessionsDir = join(dataDir, 'sessions')
  const before = new Set(listSessions(sessionsDir))
  const app = spawn(exe, [`--remote-debugging-port=${port}`], { cwd: appDir, stdio: 'ignore' })
  let cdp
  try {
    const target = await findPageTarget(port, { timeoutMs: 40000 }).catch((e) => {
      throw new Error(`${e.message}\n（多半是有另一个 Harbor 实例正在运行，单实例锁让新进程直接退了。）`)
    })
    cdp = await connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    const ev = (expr, label) => evaluate(cdp, expr, { label })
    const d = makeDriver({ scenario, ev, sessionsDir, dataDir, before, onStep })

    const ready = await waitFor(() => ev(`!!document.querySelector('textarea')`, '等输入框'), {
      timeoutMs: 30000,
      intervalMs: 500,
    })
    d.record('界面就绪（有输入框）', Boolean(ready), ready ? 'textarea 出现了' : '30 秒没等到输入框')
    if (ready) await scenario.run(d)
  } finally {
    try {
      cdp?.ws.close()
    } catch {
      /* 忽略 */
    }
    if (!keep) app.kill()
  }
}
