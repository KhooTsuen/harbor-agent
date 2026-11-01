/**
 * SEC-073 生命周期探针 —— 安全套件用的**子进程入口**（不是套件，run.mjs 不会 import 它）
 *
 * 为什么必须是子进程：`npm run security` 跑在纯 Node 里，`require('electron')` 返回的是
 * Electron 包导出的 exe 路径字符串，`app.isReady()` / `safeStorage.*` 全都不存在。
 * 而 `credentials.cjs` 的判死守卫刻意要求「已 ready」（2026-10-27 真机修复：ready 前
 * safeStorage 恒返回 false，据此判死会让启动首行误报「有凭证解不开，已停止写入」）。
 * 所以要验「ready 之后该报 undecryptable」，得先把 Electron 生命周期搭出来。
 *
 * 为什么不在测试进程里搭：`encryptionAvailable()` 会把 `true` **永久缓存**在模块里
 * （设计如此：进程生命周期内 safeStorage 不会忽有忽无），`_resetCache()` 也不清它 ——
 * 同一进程里伪造过 `true`，之后所有用例都会以为本机有加密能力，读到的 `safeStorage`
 * 却是 undefined。换进程 = 天然的干净状态，也不给产品代码加任何只读测试入口。
 *
 * 用法：node scripts/security/probes/cred-lifecycle.mjs <mode>
 *   notready       app.isReady() === false（与纯 Node 下的真实行为对齐，作对照）
 *   ready-ok       已 ready 且这台机器真能解/能加（**正对照**：写必须照常成功）
 *   ready-noenc    已 ready，但 safeStorage 不可用
 *   ready-broken   已 ready，声称能加密、解密却抛错（换过 Windows 账户的真实形状）
 * 输出：一行 JSON（父进程按行解析）。隔离：data/security-data/tmp/cred-<mode>，全程虚构凭证。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const mode = String(process.argv[2] || '')
/* ready-ok 是**正对照**：同一份 fixture、同样已 ready，只是这台机器真能解 —— 用来证明
   「写前校验」不是一律拒写（没有它，判死逻辑改成恒抛也能让上面几条全绿）。 */
const MODES = { notready: false, 'ready-ok': 'ok', 'ready-noenc': 'noenc', 'ready-broken': 'broken' }
if (!(mode in MODES)) {
  console.error(`未知模式：${mode}（可用：${Object.keys(MODES).join(' / ')}）`)
  process.exit(2)
}

/* 隔离：每个模式一个独立目录，绝不碰真 data/ 与其它用例 */
const BASE = path.join(ROOT, 'data', 'security-data', 'tmp', `cred-${mode}`)
const paths = require(path.join(ROOT, 'electron/core/paths.cjs'))
paths.markPackaged(BASE)
paths.ensureDirs()

/* 伪造 electron 模块：credentials.cjs 里 `require('electron')` 走 Module._load，替换它对被测代码是真的 */
const Module = require('node:module')
const ready = mode !== 'notready'
const kind = MODES[mode]
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { isReady: () => ready },
      safeStorage: {
        /* notready 与真实行为一致：ready 之前 safeStorage 一律报不可用（kind === false 那条）
           —— 这条别写成 `!== 'noenc'`，那会让 notready 变成「能加密」，对照就废了 */
        isEncryptionAvailable: () => kind === 'ok' || kind === 'broken',
        encryptString: (text) => (kind === 'ok' ? Buffer.from(text) : Buffer.from(`CIPHER:${text}`)),
        decryptString: (buf) => {
          if (kind === 'ok') return buf.toString('utf8') /* 真的解得开 */
          throw new Error('DPAPI 解不开（模拟换过 Windows 账户）')
        },
      },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

const credentials = require(path.join(ROOT, 'electron/core/credentials.cjs'))
const credFile = path.join(paths.DIRS.data, 'credentials.json')

/* 与 suites/privacy-credentials.mjs 的 ⑤ 同一份 fixture */
fs.mkdirSync(path.dirname(credFile), { recursive: true })
fs.writeFileSync(
  credFile,
  JSON.stringify(
    { version: 1, backend: 'safeStorage', entries: { 'provider:sec073f': { value: 'QkFTRTY0LUNJUEhFUlRFWFQ', updatedAt: 1 } } },
    null,
    2
  ),
  'utf8'
)
const before = fs.readFileSync(credFile, 'utf8')
credentials._resetCache()

/* order 决定「谁先碰库」——`set()` 未必先 `get()`，两条路径都要能判死 */
const order = String(process.argv[3] || 'set-first')
const trace = { healthAfterFirstTouch: '' }
let getThrew = false
let gotValue = null
let setThrew = false
let setError = ''

const doGet = () => {
  try {
    gotValue = credentials.get('provider:sec073f')
  } catch {
    getThrew = true
  }
}
const doSet = () => {
  try {
    credentials.set('provider:sec073h', 'sk-FAKE-073-h')
  } catch (error) {
    setThrew = true
    setError = String(error && error.message)
  }
}

if (order === 'get-first') {
  doGet()
  trace.healthAfterFirstTouch = credentials.status().health
  doSet()
} else {
  doSet()
  trace.healthAfterFirstTouch = credentials.status().health
  doGet()
}

const after = fs.readFileSync(credFile, 'utf8')
let fileBackend = ''
let savedCount = -1
let hasOriginal = false
let hasNew = false
try {
  const parsed = JSON.parse(after)
  fileBackend = parsed.backend
  savedCount = Object.keys(parsed.entries || {}).length
  hasOriginal = Boolean(parsed.entries && parsed.entries['provider:sec073f'])
  hasNew = Boolean(parsed.entries && parsed.entries['provider:sec073h'])
} catch {
  fileBackend = '<unparsable>'
}

console.log(
  JSON.stringify({
    mode,
    order,
    ready,
    kind,
    ...trace,
    healthFinal: credentials.status().health,
    setThrew,
    setError,
    getThrew,
    gotValue,
    bytesUnchanged: before === after,
    fileBackend,
    savedCount,
    hasOriginal,
    hasNew,
  })
)
