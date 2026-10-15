/**
 * Harbor 浏览器伴侣 · Phase 1b 探针版
 *
 * 唯一使命：Service Worker 一启动就连 native host 发一条 `{"ping":1}`，
 * 把结果 POST 给本地验收服务器 —— 「有没有收到 pong」因此看的是**扩展真实
 * 收到的消息**，不是我们的推测。
 *
 * ⚠️ 那个 REPORT_URL 是**探针专用**（只在 Phase 1b 验收时存在），
 *    Phase 1c 做真骨架时**必须删掉** —— 正式扩展不该往本地服务器发东西。
 *
 * 这个文件是 `.js`（不是 `.cmd`），所以中文注释没有 cmd 那个 GBK 地雷
 * （见 host.harbor-agent.cmd 顶部的说明）。
 */

const HOST = 'com.harbor.agent'
const REPORT_URL = 'http://127.0.0.1:8792/report'

function report(payload) {
  try {
    fetch(REPORT_URL, { method: 'POST', body: JSON.stringify(payload) }).catch(() => {})
  } catch {
    /* 验收服务器没起就算了，不能因为上报失败影响探针本身 */
  }
}

function probe() {
  report({ side: 'ext', stage: 'connecting' })
  let port
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch (error) {
    report({ side: 'ext', stage: 'connect-threw', error: String(error && error.message) })
    return
  }

  port.onMessage.addListener((msg) => report({ side: 'ext', stage: 'message', msg }))

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    report({ side: 'ext', stage: 'disconnect', error: err ? err.message : null })
  })

  port.postMessage({ ping: 1, at: Date.now() })
  report({ side: 'ext', stage: 'sent-ping' })
}

chrome.runtime.onInstalled.addListener(probe)
chrome.runtime.onStartup.addListener(probe)
/* SW 被唤醒时也试一次（便于手动触发 / 反复验收） */
probe()
