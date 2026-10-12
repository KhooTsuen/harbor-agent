/**
 * 凭证库 —— **API Key 不许出现在 config.json 里**：配置只留 `credentialRef`，密钥存这里。
 * 加密用 Electron 的 `safeStorage`（Windows 底层 DPAPI、绑当前用户账户），选它不选 keytar/原生
 * 模块是因为 Electron 自带、零新依赖。四点须知：
 *  ① safeStorage 只有 Electron 有；纯 Node 环境退化成明文 + `backend='plain'`，**不假装加密了**。
 *  ② 启动早期可能没就绪 → 全部懒加载 + 缓存，不在顶层 require。
 *  ③ 读出的密钥都在脱敏模块登记，之后日志/会话/导出里出现它一律被替换。
 *  ④ **状态不明时拒绝写**（2026-10-13，E2 凭证写入保护）：以前 `load()` 一个 catch 把「没建过/
 *     坏了/读不了」压成空表，下一次 `set()` 就写回去 → 用户 Key 无声消失。现在分 5 个健康态
 *     （见 `health`），只有 `ok`/`missing` 可写，其余拒写（留档 + 明确报错）；唯一出口是显式
 *     `reset({ confirm: true })`。设计见 docs/credentials写入保护-设计修订.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const redact = require('./redact.cjs')
const log = require('./log.cjs')
const { writeAtomic, keepCorruptCopy } = require('./safe-write.cjs') /* 原子写 + 损坏留档（全内核唯一那份） */

const FILE_NAME = 'credentials.json'
let cache = null /* ref -> { value(明文或 base64), updatedAt } */
let backend = null /* 已加载文件的加密后端：'safeStorage' | 'plain' */
let availability = null /* 后端可用性只探一次 */
/* 健康态（**进程内**，不落盘、不改格式、无需迁移）。只有前两个可写：
   ok 读到+解析成功+后端一致 | missing ENOENT 且**从未加载过**（首启） | corrupt 解析失败
   unreadable 读失败(非ENOENT)/加载后消失或被外部改 | undecryptable 本机解不开 */
let health = 'missing'
let healthError = '' /* 拒写原因；健康时为空串 */
let loadedOnce = false /* 区分「首次 ENOENT」与「加载后文件消失」 */
let fp = null /* 文件指纹 { size, mtimeMs }；null = 认为不存在（写前检测外部改动） */

/** data 目录下的凭证文件路径（懒 require paths.cjs，它不依赖 electron） */
function filePath() {
  return path.join(require('./paths.cjs').DIRS.data, FILE_NAME)
}

/** 文件的 { size, mtimeMs }；读不到返回 null */
function statOf(file) {
  try {
    const s = fs.statSync(file)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/** 两指纹是否一致（都 null = 都认为没有文件） */
function sameFp(a, b) {
  if (a === null && b === null) return true
  if (!a || !b) return false
  return a.size === b.size && a.mtimeMs === b.mtimeMs
}

/** 能不能加密。用 safeStorage.isEncryptionAvailable() 判断，失败一律当不能 */
function encryptionAvailable() {
  if (availability !== null) return availability
  try {
    const { safeStorage } = require('electron')
    availability = Boolean(safeStorage?.isEncryptionAvailable?.())
  } catch {
    availability = false /* 非 Electron 环境（内核单测、构建脚本） */
  }
  return availability
}

/** 空库的缓存对象 */
const emptyCache = () => ({ version: 1, backend: encryptionAvailable() ? 'safeStorage' : 'plain', entries: {} })

/** 记一个「拒写」态并留下人话原因（读路径不抛，写路径见 assertWritable） */
function markUnhealthy(state, why) {
  health = state
  healthError = why
  log.error(`[凭证库] ${why}`)
}

function load() {
  if (cache) return cache
  const file = filePath()
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    fp = statOf(file)
    cache = emptyCache()
    backend = cache.backend
    if (error?.code === 'ENOENT') {
      /* 不存在：首启（没建过）正常可写；但「曾读到过、现在没了」不能当首启——那会静默重建盖掉内容 */
      if (loadedOnce) markUnhealthy('unreadable', `凭证库在本次运行期间消失（${file}），已停止写入以免静默重建`)
      else health = 'missing'
    } else {
      /* 读不了（EPERM/EACCES/EISDIR…）→ 拒写，绝不退化成「空库」 */
      markUnhealthy('unreadable', `凭证库读不出来（${error?.code || error?.message || error}），已停止写入以免覆盖原文件`)
    }
    return cache
  }
  fp = statOf(file) /* 先记指纹（写前判外部改动），再解析 */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    cache = emptyCache()
    backend = cache.backend
    markUnhealthy('corrupt', `凭证库解析失败（${error instanceof Error ? error.message : error}），已停止写入以免覆盖原文件`)
    return cache
  }
  const fileBackend = parsed?.backend === 'safeStorage' ? 'safeStorage' : 'plain'
  const entries = parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {}
  cache = { version: 1, backend: fileBackend, entries }
  backend = fileBackend
  loadedOnce = true
  /* 后端是 safeStorage 却解不开（换账户/换机器/无密钥环）→ **绝不能再写**：一次无关 set() 会把
     backend 重贴成 plain，之后读旧条目就把 base64 密文当明文 Key 返回（2026-10-07 事故形状） */
  if (fileBackend === 'safeStorage' && !encryptionAvailable()) {
    markUnhealthy('undecryptable', '凭证库用系统加密（safeStorage）存的，但当前环境解不开（换了 Windows 账户 / 换了机器），已停止写入')
  } else {
    health = 'ok'
    healthError = ''
  }
  return cache
}

/** 拒写态 → 抛错（调用方必须看到，不许假报成功） */
function assertWritable() {
  if (health === 'ok' || health === 'missing') return
  throw new Error(`凭证库当前不可写（${health}）：${healthError}。原文件未被改动。`)
}

/* 提交：**先落盘、成功才换内存**。① 写前指纹校验（外部动过就拒写，不引锁）② writeAtomic 失败即抛、
   cache 一字不动 ③ 只有到这里才一起换 cache/backend/fp/health —— 写失败后读到的仍是旧内存，与磁盘一致 */
function commit(nextData) {
  assertWritable()
  const file = filePath()
  if (!sameFp(statOf(file), fp)) {
    markUnhealthy('unreadable', '凭证库文件在本次写入前被外部改动或消失，已停止写入以免覆盖')
    throw new Error(`凭证库文件已被外部改动（${file}），本次写入已中止。`)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeAtomic(file, JSON.stringify(nextData, null, 2)) /* 抛了就到此为止 */
  cache = nextData
  backend = nextData.backend
  fp = statOf(file)
  loadedOnce = true
  health = 'ok'
  healthError = ''
}

/** 按**目标后端**加密：是 safeStorage 才加密，本机加不了就抛（不降级成明文写坏密文库） */
function encrypt(plain, targetBackend) {
  if (targetBackend !== 'safeStorage') return { value: plain, backend: 'plain' }
  if (!encryptionAvailable()) throw new Error('本机没有系统加密能力（safeStorage 不可用），不能写入需加密的凭证库')
  const { safeStorage } = require('electron')
  return { value: safeStorage.encryptString(plain).toString('base64'), backend: 'safeStorage' }
}

function decrypt(entry, fileBackend) {
  if (fileBackend === 'plain' || !entry?.value) return entry?.value ?? ''
  try {
    const { safeStorage } = require('electron')
    if (!safeStorage?.decryptString) throw new Error('当前环境没有系统加密能力（safeStorage 不可用）')
    return safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
  } catch (error) {
    /* 换过机器/换过 Windows 用户 → DPAPI 解不开。预期内的失败，要能说清楚 */
    const why = error instanceof Error ? error.message : error
    throw new Error(`凭证解密失败（${why}）。通常是换了 Windows 账户或把 data/ 拷到了别的机器，重新填一次 API Key 即可。`)
  }
}

/** 读一个密钥。读到的值会登记进脱敏模块 */
function get(ref) {
  const data = load()
  const entry = data.entries[String(ref)]
  if (!entry) return ''
  let value
  try {
    value = decrypt(entry, data.backend)
  } catch (error) {
    /* 某条解不开 → 整库转「解不开」（拒写），但 get 的对外行为不变（继续抛） */
    markUnhealthy('undecryptable', `有凭证解不开（${error instanceof Error ? error.message : error}），已停止写入`)
    throw error
  }
  if (value) redact.remember(value, '密钥')
  return value
}

function set(ref, plain) {
  const key = String(ref ?? '').trim()
  if (!key) throw new Error('缺 credentialRef')
  const value = String(plain ?? '')
  const data = load()
  assertWritable()
  /* 复制，不原地改 —— 落盘失败时内存不受影响（旧代码直接改 cache，会留下脏内存） */
  const next = { ...data, entries: { ...data.entries } }
  if (!value) {
    delete next.entries[key]
    commit(next)
    return { ok: true, removed: true }
  }
  const packed = encrypt(value, next.backend)
  next.entries[key] = { value: packed.value, updatedAt: Date.now() }
  /* 后端**沿用文件已有的**，不按当前环境重贴（重贴会让旧密文被当明文，见文件头 ④） */
  next.backend = packed.backend
  commit(next)
  redact.remember(value, '密钥')
  return { ok: true, backend: next.backend }
}

function remove(ref) {
  const data = load()
  assertWritable()
  const key = String(ref ?? '')
  const next = { ...data, entries: { ...data.entries } }
  if (!(key in next.entries)) return { ok: true, removed: false }
  const existing = next.entries[key]?.value
  delete next.entries[key]
  commit(next)
  if (next.backend === 'plain' && existing) redact.forget(existing) /* 明文可逆，顺手摘脱敏 */
  return { ok: true, removed: true }
}

function has(ref) {
  return Boolean(load().entries[String(ref)])
}

/** 有哪些 ref（**不返回值**，只报名字和更新时间） */
function list() {
  const data = load()
  return Object.entries(data.entries).map(([ref, entry]) => ({ ref, updatedAt: entry?.updatedAt ?? 0 }))
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
      /* 不能因一个坏凭证让应用起不来 —— 但整库转「解不开」→ 拒写 */
      markUnhealthy('undecryptable', '有凭证解不开（换过 Windows 账户 / 换过机器），已停止写入')
    }
  }
  return count
}

/* 显式重置 —— 坏库的**唯一出口**，**不是** `set(force:true)`：破坏性动作单列、好审计。
   ⚠️ `confirm:true` 只是代码层门槛，不代表「用户真点过确认」（那是上层 UI 二次确认的责任）；
   **本轮不接 UI / IPC**。先留档（失败即中止）→ 原子写空库 → 成功才 `health=ok`；任何一步失败，
   原文件与健康态都**不动**，绝不留「半重置」 */
function reset(options = {}) {
  if (options?.confirm !== true) {
    throw new Error('重置凭证库需要显式确认（reset({ confirm: true })）—— 它会把现有凭证全部清掉')
  }
  const file = filePath()
  let archived = ''
  if (fs.existsSync(file)) {
    archived = keepCorruptCopy(file)
    if (!archived) throw new Error(`留档失败，已中止重置（原文件未改动）：${file}。请检查磁盘空间 / 权限。`)
  }
  const fresh = emptyCache()
  writeAtomic(file, JSON.stringify(fresh, null, 2))
  cache = fresh
  backend = fresh.backend
  fp = statOf(file)
  loadedOnce = true
  health = 'ok'
  healthError = ''
  return { ok: true, archived, reason: String(options.reason ?? '') }
}

/** 给自己人看的实情（诊断包用）：加密了吗、有几个凭证、健康不健康 */
function status() {
  const data = load()
  return {
    encryptionAvailable: encryptionAvailable(),
    backend: data.backend,
    count: Object.keys(data.entries).length,
    file: filePath(),
    health,
    healthError,
  }
}

/** 仅供测试：丢掉进程内缓存，让下一次调用重新从磁盘加载 */
function _resetCache() {
  cache = null; backend = null
  health = 'missing'; healthError = ''
  loadedOnce = false; fp = null
}

module.exports = {
  get, set, remove, has, list, status, reset, primeRedaction, encryptionAvailable, _resetCache,
  refForProvider: (providerId) => `provider:${providerId}`,
  refForSearch: (provider) => `search:${provider}`,
  refForMcp: (serverId) => `mcp:${serverId}`,
}
