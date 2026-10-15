/**
 * Phase 0 探针 · 扩展侧
 *
 * 目标：加载扩展后**自动**触发一次 connectNative，把 {"ping":1} 发出去。
 * 为什么用 onInstalled/onStartup 自动触发：这样整个实测不需要人手点界面。
 *
 * 它同时把「收到 pong 没有」通过 navigator.sendBeacon / fetch 报给本地探针服务器 ——
 * 服务器是 unhandled reject 也不管，核心判据在 host 侧那个文件里。
 */

const HOST = 'com.harbor.phase0.probe'
const REPORT_URL = 'http://127.0.0.1:8791/report'

function report(payload) {
  try {
    fetch(REPORT_URL, {
      method: 'POST',
      body: JSON.stringify(payload),
    }).catch(() => {})
  } catch {
    /* 忽略 */
  }
}

function probe() {
  report({ side: 'ext', stage: 'connecting' })
  let port
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch (e) {
    report({ side: 'ext', stage: 'connect-threw', error: String(e && e.message) })
    return
  }

  port.onMessage.addListener((msg) => {
    report({ side: 'ext', stage: 'got-message', message: msg })
  })

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    report({ side: 'ext', stage: 'disconnected', error: err ? err.message : null })
  })

  port.postMessage({ ping: 1, at: Date.now() })
  report({ side: 'ext', stage: 'sent-ping' })
}

chrome.runtime.onInstalled.addListener(probe)
chrome.runtime.onStartup.addListener(probe)
/* SW 被唤醒时也试一次（便于手动触发） */
probe()
