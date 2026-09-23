/**
 * 会话内容加密：**逐行封装**，不是整文件加密
 *
 * JSONL 的价值在三点：追加即写、崩了只丢最后一行、能用文本编辑器看。整文件加密
 * 会把三点全废掉（追加一句就得整篇解密再重加密，崩在中间就是整篇损坏）。所以
 * **每一行单独封印**成一个 blob，格式：
 *
 *     e1:<base64(iv(12) | tag(16) | ciphertext)>
 *
 * 追加一行 = 加密那一行再 append（写路径语义不变）；读 = 逐行解开，**某一行解不开
 * 就跳过那一行**，不让整段会话读不出来。
 *
 * ── 为什么默认关（`security.encryptSessions` 默认 false）──
 *
 * 开启会**重写用户已有的全部会话文件**。按硬约束 #5，那是大规模数据改动，必须有
 * 迁移、必须保留旧数据。默认开 = 用户升级一次就被静默重写全部聊天记录。所以做成
 * **显式开启**，且开启时先自动备份（见 migrate）。
 *
 * ── 为什么密钥拿不到时不回落明文 ──
 *
 * 「以为加密了、其实没加」（密文与明文混在一个文件里，用户毫无察觉）是最糟的结果，
 * 所以启用状态下 `sealLine` **抛错**，让上层把话原样传给用户。
 *
 * 只依赖 node:crypto 与 credentials.cjs，**不 require electron**（内核自检要能跑）。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const log = require('./log.cjs')
const { DIRS } = require('./paths.cjs')

const PREFIX = 'e1:'
const ALGO = 'aes-256-gcm'
/** 密钥存在 credentials.cjs 的哪个 ref 下（**不进 config.json** —— 硬约束 #4） */
const KEY_REF = 'session:master'
const KEY_LEN = 32
const IV_LEN = 12
const TAG_LEN = 16

/** 进程内缓存解出来的密钥：每行都要用，不能每行都去读文件 */
let cachedKey = null

const reason = (error) => (error instanceof Error ? error.message : String(error))
const credentials = () => require('./credentials.cjs')

/**
 * 开没开加密：读 `security.encryptSessions`，**默认 false**。读配置失败时按未启用
 * 处理并留一条日志（不静默）：抛错会让整个会话写盘全挂，代价比一次降级大。
 * **读方向不受影响** —— openLine 只看前缀、不看这个开关。
 */
function isEnabled() {
  try {
    return require('./config.cjs').get()?.security?.encryptSessions === true
  } catch (error) {
    log.warn(`读不到会话加密开关，本次按「未启用」处理：${reason(error)}`)
    return false
  }
}

/** 读密钥：没存过返回 null；**读不出来就抛错**（读不出来必须让上层知道） */
function loadKey() {
  if (cachedKey) return cachedKey
  let raw = ''
  try {
    raw = credentials().get(KEY_REF)
  } catch (error) {
    throw new Error(`会话加密密钥读不出来（${reason(error)}）。密钥绑当前 Windows 账户，换过账户或把 data/ 拷到别的机器就会这样。`)
  }
  if (!raw) return null
  const key = Buffer.from(String(raw), 'base64')
  if (key.length !== KEY_LEN) {
    throw new Error(`会话加密密钥长度不对（${key.length} 字节，应为 ${KEY_LEN}）；credentials.json 里的 ${KEY_REF} 可能被手改过。`)
  }
  cachedKey = key
  return key
}

/** 有密钥就返回，没有 / 拿不到就**抛错** —— 绝不静默写成明文 */
function requireKey() {
  const key = loadKey()
  if (key) return key
  throw new Error(`没有会话加密密钥，这一行不能加密。请在设置里重新开启会话加密（会生成新密钥），或检查 credentials.json 是否可写（ref：${KEY_REF}）。`)
}

/** 第一次开启时生成密钥。**已存在就不动** —— 换密钥会让老会话全解不开 */
function ensureKey() {
  if (loadKey()) return
  const fresh = crypto.randomBytes(KEY_LEN).toString('base64')
  credentials().set(KEY_REF, fresh)
  cachedKey = Buffer.from(fresh, 'base64')
}

/** 纯封印：不看配置、不检查前缀（sealLine 与 migrate 共用） */
function sealWith(text, key) {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

/**
 * 封印一行。
 *
 * · 未启用 → 原样返回（现有行为不变）
 * · 已是密文 → 原样返回（**幂等**：migrate 第二遍必须能跑，抛出会把「可重入」变成
 *   「失败」。而 JSONL 每行都以 `{` 开头，不可能真的和 `e1:` 撞前缀）
 * · 启用但拿不到密钥 → **抛错**，不回落明文
 */
function sealLine(text) {
  const input = String(text ?? '')
  if (!isEnabled()) return input
  if (input.startsWith(PREFIX)) return input
  return sealWith(input, requireKey())
}

/** 纯解密：格式不对 / 认证失败都抛（上层负责翻译成人话） */
function openWith(text, key) {
  const blob = Buffer.from(text.slice(PREFIX.length), 'base64')
  if (blob.length <= IV_LEN + TAG_LEN) throw new Error('密文不完整')
  const decipher = crypto.createDecipheriv(ALGO, key, blob.subarray(0, IV_LEN))
  decipher.setAuthTag(blob.subarray(IV_LEN, IV_LEN + TAG_LEN))
  return Buffer.concat([decipher.update(blob.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8')
}

/**
 * 带原因的解封：解不开时 `ok: false`，且 `error` 是**人话**。
 * 没有 `e1:` 前缀一律原样返回 —— **老数据（明文）在启用状态下照样能读**，迁移没跑完
 * 也不影响。这个函数**不抛错**（readLines 靠它逐行兜底）。
 */
function openLineDetailed(text) {
  const input = String(text ?? '')
  if (!input.startsWith(PREFIX)) return { ok: true, text: input }
  let key
  try {
    key = loadKey()
  } catch (error) {
    return { ok: false, text: '', error: `这一行解不开：${reason(error)}` }
  }
  if (!key) {
    return {
      ok: false,
      text: '',
      error: `这一行解不开：找不到会话加密密钥（${KEY_REF}）。这一行会跳过，会话其余内容不受影响。`,
    }
  }
  try {
    return { ok: true, text: openWith(input, key) }
  } catch (error) {
    return {
      ok: false,
      text: '',
      error: `这一行解不开（${reason(error)}）。通常是换了 Windows 账户、或把 data/ 拷到了别的机器 —— 密钥绑当前账户。这一行会跳过，会话其余内容不受影响。`,
    }
  }
}

/** 解封一行；解不开返回空串（要原因用 openLineDetailed） */
function openLine(text) {
  return openLineDetailed(text).text
}

/** 密钥能不能拿到（给界面 / 诊断用） */
function keyInfo() {
  try {
    return loadKey()
      ? { available: true, ref: KEY_REF }
      : { available: false, ref: KEY_REF, error: '还没有会话加密密钥（第一次开启加密时会自动生成）' }
  } catch (error) {
    return { available: false, ref: KEY_REF, error: reason(error) }
  }
}

/** 这一行需要转换吗（幂等判断；逻辑必须与 convert 一致） */
const needsConvert = (raw, enable) =>
  raw.split('\n').some((line) => line.trim() && line.trim().startsWith(PREFIX) !== enable)

/** 整篇转换：空行原样保留，已是目标形态的行原样保留 */
function convert(raw, enable, key) {
  let changed = 0
  const out = raw.split('\n').map((line) => {
    const text = line.trim()
    if (!text) return line
    if (text.startsWith(PREFIX) === enable) return line
    changed += 1
    if (enable) return sealWith(text, key)
    const opened = openLineDetailed(text)
    if (!opened.ok) throw new Error(opened.error)
    return opened.text
  })
  return { text: out.join('\n'), changed }
}

/** 同目录写临时文件再 rename —— 中途崩了不会留下半个文件 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 把一批会话文件整体转换一遍：`enable: true` 加密，`false` 解密。
 *
 * 四条保证（都是数据事故换来的底线）：
 *  ① **先备份**：默认调 backup.cjs 的 create()；备份失败就中止，一个字节都不改。
 *  ② **幂等**：已是目标形态的行原样跳过 —— 同方向跑第二遍 failed: 0 且内容不变。
 *  ③ **原子**：单文件「整篇解开 → 整篇封印 → 写临时文件 → rename」，任何一行解不开
 *     就**不写**，原文件保持不动；某个文件失败即停并如实报告，前面已转换的不回滚
 *     （跨文件回滚要另写一套事务，而回滚点已经在备份里了）。
 *  ④ **可注入**：`dir` / `backupFn` 只给自检注入沙箱用；**默认值就是数据目录与真备份**。
 *
 * @param {{ enable: boolean, dir?: string, backupFn?: Function }} opts
 * @returns {{ ok, files, lines, failed, backup, converted, skipped, error? }}
 */
function migrate(opts = {}) {
  const enable = opts.enable === true
  const dir = typeof opts.dir === 'string' && opts.dir ? opts.dir : DIRS.sessions
  const result = { ok: true, files: 0, lines: 0, failed: 0, backup: '', converted: [], skipped: [] }

  /* ① 先看有没有活要干：已是目标形态的方向不该白做一次备份 */
  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
  } catch {
    names = []
  }
  const pending = []
  for (const name of names) {
    const file = path.join(dir, name)
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      return { ...result, ok: false, failed: 1, error: `${name} 读不出来：${reason(error)}` }
    }
    if (needsConvert(raw, enable)) pending.push({ name, file })
    else result.skipped.push(name)
  }
  if (pending.length === 0) return result

  /* ② 备份。没有回滚点的大规模改写不许开始 */
  const makeBackup = opts.backupFn ?? require('./backup.cjs').create
  let backup = null
  try {
    backup = makeBackup(enable ? 'before-session-encrypt' : 'before-session-decrypt')
  } catch (error) {
    backup = { ok: false, error: reason(error) }
  }
  if (!backup || backup.ok !== true) {
    return { ...result, ok: false, error: `备份失败，已中止（没有回滚点不敢改写会话）：${backup?.error ?? '未知原因'}` }
  }
  result.backup = String(backup.name || backup.path || '')

  /* ③ 拿密钥。启用方向需要（没有就生成）；停用方向解密也要用 */
  let key = null
  try {
    if (enable) ensureKey()
    key = loadKey()
  } catch (error) {
    return { ...result, ok: false, error: `拿不到会话加密密钥，已中止：${reason(error)}` }
  }

  /* ④ 逐个文件转换。失败即停，已转换的保持已转换 */
  for (const item of pending) {
    try {
      const raw = fs.readFileSync(item.file, 'utf8')
      const done = convert(raw, enable, key)
      writeAtomic(item.file, done.text)
      result.files += 1
      result.lines += done.changed
      result.converted.push(item.name)
    } catch (error) {
      result.ok = false
      result.failed += 1
      result.error = `${item.name} 转换失败（已停止，前面的文件保持已转换）：${reason(error)}`
      log.warn(`会话加密迁移中止：${reason(error)}`)
      return result
    }
  }

  log.info(`会话加密迁移完成（enable=${enable}）：${result.files} 个文件 / ${result.lines} 行，备份 ${result.backup}`)
  return result
}

module.exports = {
  PREFIX,
  isEnabled,
  sealLine,
  openLine,
  openLineDetailed,
  keyInfo,
  migrate,
  /** 自检用：清掉进程内密钥缓存（换过假 credentials 之后必须调） */
  _resetKeyCache: () => {
    cachedKey = null
  },
}
