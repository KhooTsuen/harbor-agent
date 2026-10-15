/**
 * 三组实验共用的探针扩展。
 *
 * 启动时对**三个候选 host 名**各试一次 connectNative 并把结果上报给本地报告服务器。
 * 为什么是三个名：每个实验注册自己那个键（独立注册表键），扩展不用改。
 * 未注册的名会立刻 disconnect（lastError = "Specified native messaging host not found."），
 * 那个噪音同时也是一条有用的对照证据。
 *
 * 同时上报 chrome.runtime.id —— 这是「加载一次读真实扩展 ID」的落实（清单的
 * allowed_origins 必须用它，不能靠路径算）。
 */

const HOSTS = ['com.harbor.exp1', 'com.harbor.exp2', 'com.harbor.exp3']
const REPORT_URL = 'http://127.0.0.1:8792/report'

function report(payload) {
  try {
    fetch(REPORT_URL, { method: 'POST', body: JSON.stringify(payload) }).catch(() => {})
  } catch {
    /* 服务器没起也不管 */
  }
}

function probe(host) {
  report({ side: 'ext', extId: chrome.runtime.id, host, stage: 'connecting' })
  let port
  try {
    port = chrome.runtime.connectNative(host)
  } catch (e) {
    report({ side: 'ext', host, stage: 'connect-threw', error: String(e && e.message) })
    return
  }

  port.onMessage.addListener((msg) => report({ side: 'ext', host, stage: 'message', msg }))
  port.onDisconnect.addListener(() =>
    report({
      side: 'ext',
      host,
      stage: 'disconnect',
      error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null,
    }),
  )

  try {
    port.postMessage({ ping: 1, at: Date.now() })
  } catch (e) {
    report({ side: 'ext', host, stage: 'post-threw', error: String(e && e.message) })
  }
}

function probeAll() {
  for (const h of HOSTS) probe(h)
}

chrome.runtime.onInstalled.addListener(probeAll)
chrome.runtime.onStartup.addListener(probeAll)
/* SW 被唤醒时也试一次 */
probeAll()
