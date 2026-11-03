/**
 * `tools/e2e-ingest-keeps-stream.mjs` 的**零件**（从那边拆出来的，主脚本贴到 316 行 = 超红线）。
 *
 * 只管三件「和判据无关」的事：改隔离数据、读盘数轮次、走真管道发 `ext:page`。
 * 判据本身留在主脚本 —— 那里要一眼读完「什么时候注入、注入后查什么」。
 */
import { createRequire } from 'node:module'
import { connect as connectPipe } from 'node:net'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/* 协议真相源直接 require 内核那份（.cjs；ESM 里用 createRequire） */
const P = createRequire(import.meta.url)(resolve(ROOT, 'electron', 'core', 'ext-protocol.cjs'))

/**
 * 把隔离区的配置指到假上游，并返回「跑完还原」的函数。
 *
 * 为什么必须还原：隔离区（`data/unit-test-data`）虽然是测试专用，但上一次跑崩了
 * 会留下**指向假上游**的配置 —— 下一次跑真机测试时会莫名其妙连不上模型。
 *
 * @param {{ conf: string, cred: string, baseUrl: string }} o
 * @returns {() => void}
 */
export function maskData({ conf, cred, baseUrl }) {
  mkdirSync(resolve(conf, '..'), { recursive: true })
  const confBackup = existsSync(conf) ? readFileSync(conf, 'utf8') : null
  const credBackup = existsSync(cred) ? readFileSync(cred, 'utf8') : null
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
  const ref = cfg.providers[0].credentialRef
  cfg.providers[0].baseUrl = baseUrl
  writeFileSync(conf, JSON.stringify(cfg, null, 2))
  writeFileSync(
    cred,
    JSON.stringify(
      { version: 1, backend: 'plain', entries: { [ref]: { value: 'sk-e2e', updatedAt: Date.now() } } },
      null,
      2,
    ),
  )
  const put = (file, backup) => {
    try {
      if (backup === null) rmSync(file, { force: true })
      else writeFileSync(file, backup)
    } catch {
      /* ignore */
    }
  }
  return () => {
    put(conf, confBackup)
    put(cred, credBackup)
  }
}

/**
 * 盘上已经跑完第几轮工具 —— **「任务真在干活」的硬证据**。
 *
 * 假上游给每轮的工具调用一个 id（`call_busy_N`），内核真执行完会把它写进会话文件。
 * 读它比读界面可靠：跑的时候界面只给「实时任务」四个字，工具明细要等收尾才渲染。
 *
 * ★ `since` 是**必须**的（2026-11-04 真机逮到）：隔离区里留着上次跑的会话文件，
 *   里面已经有 `call_busy_14`。不按时间过滤的话基线就是 14，本次的 1~14 减掉之后
 *   永远 ≤0 —— 判据会一直等。按 mtime 只认**这次开跑之后还在写的**文件。
 *
 * @param {string} sessionsDir 隔离区的 sessions 目录
 * @param {number} since 本次开跑的时刻（毫秒时间戳）；只统计这之后写过的文件
 * @returns {number} 出现过的最大轮次；读不到就是 0
 */
export function busyRoundOnDisk(sessionsDir, since) {
  let max = 0
  try {
    for (const f of readdirSync(sessionsDir).filter((n) => n.endsWith('.jsonl'))) {
      const full = resolve(sessionsDir, f)
      if (statSync(full).mtimeMs < since) continue
      for (const m of readFileSync(full, 'utf8').matchAll(/call_busy_(\d+)/g)) {
        const n = Number(m[1])
        if (n > max) max = n
      }
    }
  } catch {
    /* 目录还没建 / 文件正在写 —— 下次采样再看 */
  }
  return max
}

/**
 * 经真命名管道发一条 `ext:page`（与扩展读页**同一条路、同一个 token**）。
 *
 * 不用 IPC、不直连内核：这条链路正是用户报的问题所在（主进程写盘 → 推 →
 * 渲染层重读盘），绕开它就验不到真东西。
 *
 * @param {{ iso: string, payload: object }} o
 * @returns {Promise<object>} 主进程的答复；超时给 `{ error: 'timeout' }`
 */
export function sendExtPage({ iso, payload }) {
  const frame = P.encodeFrame(
    P.request({ id: 'e2e-1', kind: P.KIND.EXT_PAGE, payload, token: P.readToken(iso) }),
  )
  return new Promise((done) => {
    const sock = connectPipe(P.pipeName(iso))
    let buf = Buffer.alloc(0)
    let replied = null
    const finish = (v) => {
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      done(v)
    }
    sock.on('connect', () => sock.write(frame))
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (const m of P.decodeFrames(buf).messages) if (P.isReply(m) || P.isPush(m)) replied = m
      if (replied) finish(replied)
    })
    sock.on('error', (error) => finish({ error: error.message }))
    setTimeout(() => finish(replied ?? { error: 'timeout' }), 8000)
  })
}

/** 填输入框（真触发 input 事件，走 React 自己的 onChange） */
export const fillExpr = (text) =>
  `(function(){const ta=document.querySelector('textarea');if(!ta)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set;s.call(ta, ${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value.length})()`

/** 最后一条消息：id + 正文长度 + 开头 */
export const LAST_MSG = `(function(){const a=[...document.querySelectorAll('[data-message-id]')];const el=a[a.length-1];if(!el)return null;const t=(el.textContent||'').trim();return {id:el.getAttribute('data-message-id'),len:t.length,head:t.slice(0,80)}})()`

/** 这一轮在不在跑：运行中过程入口挂 `.process-live`，文案恒为「实时任务」 */
export const LIVE = `(function(){const el=document.querySelector('.process-live');return el?(el.textContent||'').trim():''})()`

/** 注入的网页内容有没有以折叠卡出现 */
export const NOTE_SEEN = `(function(){const t=(document.querySelector('main')||document.body).textContent||'';return t.includes('已读取网页')||t.includes('已读网页')})()`

/** 整个正文（等收尾用） */
export const BODY_TEXT = `(function(){return (document.querySelector('main')||document.body).textContent||''})()`
