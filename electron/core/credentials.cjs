/**
 * 凭证库
 *
 * **API Key 不许出现在 config.json 里。** 配置里只留一个 `credentialRef`
 * （比如 `provider:deepseek`），真正的密钥存这里。
 *
 * 加密方式：Electron 的 `safeStorage` —— Windows 上底层就是 **DPAPI**，
 * 密钥绑当前用户账户，别的用户/别的机器拷走也解不开。
 * 用它而不是 keytar/DPAPI 原生模块的理由：**Electron 自带，零新依赖**，
 * 不用再经历一遍 node-pty 那种「装不上/打包漏拷/ABI 不对」的折腾。
 *
 * 三个必须说清楚的点：
 *
 * ① `safeStorage` 只有 Electron 里能用。纯 Node 环境（内核单测）会退化成
 *    明文存储 + 明确标记 backend='plain'，并且 `available()` 返回 false ——
 *    **不能假装加密了**。诊断包里会如实报出来。
 *
 * ② 进程启动早期 Electron 的 `safeStorage` 可能还没就绪，所以所有访问
 *    都是懒加载 + 缓存，不在模块顶层 require。
 *
 * ③ 每个读出来的密钥都会在脱敏模块里登记，之后所有日志/会话/导出里
 *    出现它一律被替换掉。这是「Secret 不外泄」的第二道闸。
 */

const fs = require('node:fs')
const path = require('node:path')
const redact = require('./redact.cjs')

const FILE_NAME = 'credentials.json'

/** ref -> { value: string(明文或 base64), updatedAt: number } */
let cache = null
/** 当前会话用的后端：'safeStorage' | 'plain' */
let backend = null
/** 后端可用性只探一次 */
let availability = null

function filePath() {
  /* 懒 require：paths.cjs 不依赖 electron，可以放心引 */
  return path.join(require('./paths.cjs').DIRS.data, FILE_NAME)
}

/** 能不能加密。用 safeStorage.isEncryptionAvailable() 判断，失败一律当不能 */
function encryptionAvailable() {
  if (availability !== null) return availability
  try {
    const { safeStorage } = require('electron')
    availability = Boolean(safeStorage?.isEncryptionAvailable?.())
    backend = availability ? 'safeStorage' : 'plain'
  } catch {
    /* 非 Electron 环境（内核单测、构建脚本） */
    availability = false
    backend = 'plain'
  }
  return availability
}

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    cache = {
      version: 1,
      backend: typeof parsed.backend === 'string' ? parsed.backend : 'plain',
      entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
    }
    /* 上次存的时候用了哪个后端，记下来 —— 混用会导致解密失败 */
    backend = cache.backend
  } catch {
    /*
     * 全新文件：后端按**当前环境实际能力**定，不能想当然写 safeStorage ——
     * 纯 Node 环境下那样写会导致「存的是明文、读的时候去解密」。
     */
    cache = { version: 1, backend: encryptionAvailable() ? 'safeStorage' : 'plain', entries: {} }
  }
  return cache
}

function persist() {
  const data = load()
  fs.mkdirSync(path.dirname(filePath()), { recursive: true })
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8')
}

function encrypt(plain) {
  if (!encryptionAvailable()) return { value: plain, backend: 'plain' }
  const { safeStorage } = require('electron')
  return { value: safeStorage.encryptString(plain).toString('base64'), backend: 'safeStorage' }
}

function decrypt(entry, fileBackend) {
  if (fileBackend === 'plain' || !entry?.value) return entry?.value ?? ''
  try {
    const { safeStorage } = require('electron')
    if (!safeStorage?.decryptString) {
      throw new Error('当前环境没有系统加密能力（safeStorage 不可用）')
    }
    return safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
  } catch (error) {
    /* 换过机器/换过 Windows 用户 → DPAPI 解不开。这是预期内的失败，要能说清楚 */
    throw new Error(
      `凭证解密失败（${error instanceof Error ? error.message : error}）。` +
        `通常是换了 Windows 账户或把 data/ 拷到了别的机器，重新填一次 API Key 即可。`,
    )
  }
}

/** 读一个密钥。读到的值会登记进脱敏模块 */
function get(ref) {
  const data = load()
  const entry = data.entries[String(ref)]
  if (!entry) return ''
  const value = decrypt(entry, data.backend)
  if (value) redact.remember(value, '密钥')
  return value
}

function set(ref, plain) {
  const key = String(ref ?? '').trim()
  if (!key) throw new Error('缺 credentialRef')

  const value = String(plain ?? '')
  const data = load()

  if (!value) {
    delete data.entries[key]
    persist()
    return { ok: true, removed: true }
  }

  const packed = encrypt(value)
  data.entries[key] = { value: packed.value, updatedAt: Date.now() }
  /*
   * **整个文件只用一个后端**。混着存会让「解密成功但拿到垃圾」这类问题
   * 变得极难查 —— 所以每次写入都以当前环境为准，统一掉。
   */
  data.backend = packed.backend
  backend = packed.backend
  persist()

  redact.remember(value, '密钥')
  return { ok: true, backend: data.backend }
}

function remove(ref) {
  const data = load()
  const key = String(ref ?? '')
  if (!(key in data.entries)) return { ok: true, removed: false }

  const existing = data.entries[key]?.value
  delete data.entries[key]
  persist()

  /* 明文后端下值是可逆的，能顺手从脱敏表里摘掉 */
  if (data.backend === 'plain' && existing) redact.forget(existing)
  return { ok: true, removed: true }
}

function has(ref) {
  return Boolean(load().entries[String(ref)])
}

/** 有哪些 ref（**不返回值**，只报名字和更新时间） */
function list() {
  const data = load()
  return Object.entries(data.entries).map(([ref, entry]) => ({
    ref,
    updatedAt: entry?.updatedAt ?? 0,
  }))
}

/** 把所有已存的密钥登记进脱敏表 —— 启动时调一次，之后写日志才安全 */
function primeRedaction() {
  const data = load()
  let count = 0
  for (const ref of Object.keys(data.entries)) {
    try {
      const value = decrypt(data.entries[ref], data.backend)
      if (value) {
        redact.remember(value, '密钥')
        count += 1
      }
    } catch {
      /* 解不开的就算了，不能因为一个坏凭证让整个应用起不来 */
    }
  }
  return count
}

/** 给自己人看的实情（诊断包用）：加密了吗、有几个凭证 */
function status() {
  const data = load()
  return {
    encryptionAvailable: encryptionAvailable(),
    backend: data.backend,
    count: Object.keys(data.entries).length,
    file: filePath(),
  }
}

module.exports = {
  get,
  set,
  remove,
  has,
  list,
  status,
  primeRedaction,
  encryptionAvailable,
  refForProvider: (providerId) => `provider:${providerId}`,
  refForSearch: (provider) => `search:${provider}`,
  refForMcp: (serverId) => `mcp:${serverId}`,
}
