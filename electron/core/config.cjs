/**
 * 配置：读写（字段校验在 config-normalize.cjs，默认值在 config-defaults.cjs）。
 * ★ apiKey **不落这个文件**：老配置的明文 key 首次加载时搬进凭证库（credentials.cjs）
 *   并从文件抹掉；界面看到的永远是掩码 + `hasKey`。落盘走原子写，先落盘再换内存。
 */

const fs = require('node:fs')
const path = require('node:path')
const { configFile, DIRS } = require('./paths.cjs')
const C = require('./config-defaults.cjs')
const { normalize } = require('./config-normalize.cjs')
const log = require('./log.cjs')
const credentials = require('./credentials.cjs')
const { writeAtomic } = require('./safe-write.cjs') /* 内核唯一那份文本原子写 */
const redact = require('./redact.cjs')
const providerCaps = require('./provider-capabilities.cjs')
/* 后端种类（openai / codex-cli）与「需不需要 Key」—— 判据的**唯一一处**（硬约束 #9） */
const kinds = require('./provider-kinds.cjs')

let cache = null

/** 把老版本遗留的明文密钥搬进凭证库（只搬运：搬完清空原字段）。@returns {{moved:number,refs:string[]}} */
function migrateLegacySecrets(cfg) {
  const refs = []

  for (const provider of cfg.providers) {
    if (!provider._legacyApiKey) continue
    try {
      credentials.set(provider.credentialRef, provider._legacyApiKey)
      refs.push(provider.credentialRef)
    } catch (error) {
      console.warn(
        '[config] 迁移 provider 密钥失败：',
        error instanceof Error ? error.message : error,
      )
    }
    provider._legacyApiKey = ''
  }

  if (cfg.search._legacyApiKey) {
    const ref = cfg.search.credentialRef || `search:${cfg.search.provider || 'custom'}`
    try {
      credentials.set(ref, cfg.search._legacyApiKey)
      cfg.search.credentialRef = ref
      refs.push(ref)
    } catch (error) {
      console.warn('[config] 迁移搜索密钥失败：', error instanceof Error ? error.message : error)
    }
    cfg.search._legacyApiKey = ''
  }

  return { moved: refs.length, refs }
}

/** Node 的错误信息在不同版本里字段不一样，统一取一次 */
function messageOf(error) {
  return error?.message ?? String(error)
}

/** 落盘前把只存在于内存的字段摘掉 */
function stripInternal(cfg) {
  /* _loadWarning 只活在内存里（给界面提示用），落盘时摘掉 */
  const { _loadWarning, ...rest } = cfg
  return {
    ...rest,
    providers: rest.providers.map(({ _legacyApiKey, ...p }) => p),
    search: (({ _legacyApiKey, ...s }) => s)(rest.search),
  }
}

function load() {
  if (cache) return cache

  let raw = null
  let loadWarning = ''
  let original = ''
  try {
    original = fs.readFileSync(configFile(), 'utf8')
    raw = JSON.parse(original)
  } catch (error) {
    /*
     * 配置读不出来时**先留一份现场**再回退默认：否则启动后某次设置同步会把坏文件
     * 覆盖成默认值，用户的 provider 列表 / 工作目录 / 快捷键静默消失、毫无提示
     * （破坏性测试实测：截断 config.json 后启动，providers 2→1、workdir 被清空）。
     * 配置这边做不到「不回写」（设置改一次就要写一次），所以至少让原文件活在一份
     * `.broken-<时间戳>` 里并让界面能提示；credentials.cjs 那边更好（坏文件原样不动）。
     */
    loadWarning = error instanceof Error ? messageOf(error) : String(error)
    if (original) {
      try {
        const backup = `${configFile()}.broken-${Date.now()}`
        fs.writeFileSync(backup, original, 'utf8')
        log.warn(`配置损坏，已留存现场：${backup}`)
      } catch {
        /* 备份失败也不能拦住启动 */
      }
    }
  }

  cache = normalize(raw)
  cache._loadWarning = loadWarning

  /* 老配置里可能有明文 key —— 搬家并立刻重写文件 */
  const migrated = migrateLegacySecrets(cache)
  if (migrated.moved > 0) {
    console.log(`[config] 已把 ${migrated.moved} 个明文密钥搬进凭证库：${migrated.refs.join(', ')}`)
    try {
      cache.updatedAt = Date.now()
      writeFile(cache)
    } catch (error) {
      console.warn('[config] 迁移后重写配置失败：', error instanceof Error ? error.message : error)
    }
  }

  /* 把已有密钥登记进脱敏表 —— 之后的日志/会话才不会漏出去 */
  credentials.primeRedaction()

  return cache
}

function writeFile(cfg) {
  fs.mkdirSync(DIRS.data, { recursive: true })
  writeAtomic(configFile(), JSON.stringify(stripInternal(cfg), null, 2))
}

function save(next) {
  const merged = normalize(next ?? cache)
  merged.updatedAt = Date.now()
  migrateLegacySecrets(merged)
  writeFile(merged) // ★ 先落盘，成功了才换内存：反了就是「内存新值 / 磁盘旧值」，下次保存别的字段会把脏值带进磁盘
  cache = merged
  return merged
}

function get() {
  return load()
}

/** 深合并一部分字段进去并落盘 */
function patch(partial) {
  const current = load()
  const next = {
    ...current,
    ...partial,
    general: { ...current.general, ...(partial.general ?? {}) },
    assistant: { ...current.assistant, ...(partial.assistant ?? {}) },
    tools: {
      ...current.tools,
      ...(partial.tools ?? {}),
      shellPolicy: { ...current.tools.shellPolicy, ...(partial.tools?.shellPolicy ?? {}) },
    },
    search: { ...current.search, ...(partial.search ?? {}) },
    memory: { ...current.memory, ...(partial.memory ?? {}) },
    context: {
      ...current.context,
      ...(partial.context ?? {}),
      budget: { ...current.context.budget, ...(partial.context?.budget ?? {}) },
    },
    router: {
      ...current.router,
      ...(partial.router ?? {}),
      roles: { ...current.router.roles, ...(partial.router?.roles ?? {}) },
    },
    fallback: { ...current.fallback, ...(partial.fallback ?? {}) },
    audit: { ...current.audit, ...(partial.audit ?? {}) },
    changeset: { ...current.changeset, ...(partial.changeset ?? {}) },
    downloads: { ...current.downloads, ...(partial.downloads ?? {}) },
    mcp: partial.mcp ?? current.mcp,
    scenes: { ...current.scenes, ...(partial.scenes ?? {}) },
    providers: partial.providers ?? current.providers,
    /* 单价（A-展示）：providers 比顶层多一层，要单独深合并 —— 不这么做，
       只改了一个模型的价会把整张价目表替换掉（其余回落默认，等于抹了用户的设置） */
    pricing: {
      ...current.pricing,
      ...(partial.pricing ?? {}),
      providers: { ...current.pricing.providers, ...(partial.pricing?.providers ?? {}) },
    },
  }
  return save(next)
}

/** 这个供应商配好 Key 了吗 */
function hasKey(provider) {
  return Boolean(provider?.credentialRef) && credentials.has(provider.credentialRef)
}

/** 取某个供应商的真实密钥（**只在发请求时调**，别往界面传） */
function providerKey(provider) {
  if (!provider?.credentialRef) return ''
  return credentials.get(provider.credentialRef)
}

/** 搜索用的密钥 */
function searchKey(cfg = load()) {
  if (!cfg.search.credentialRef) return ''
  return credentials.get(cfg.search.credentialRef)
}

/** 给界面用的版本。**必须把密钥藏掉**：返回的 apiKey 永远是掩码，真实值只在主进程发请求时取。 */
function forRenderer() {
  const c = load()
  return {
    ...stripInternal(c),
    /* 配置损坏的提示要留给界面 —— stripInternal 会把它摘掉，这里补回来 */
    _loadWarning: c._loadWarning,
    providers: c.providers.map((p) => {
      const configured = hasKey(p)
      return {
        ...stripInternal({ ...c, providers: [p] }).providers[0],
        apiKey: configured ? '••••••••' : '',
        hasKey: configured,
      }
    }),
    search: {
      ...stripInternal(c).search,
      apiKey: searchKey(c) ? '••••••••' : '',
      hasKey: Boolean(searchKey(c)),
    },
    /** 凭证库自身状态：加密了吗、用哪个后端、几个凭证 */
    credentials: credentials.status(),
    /* 模型能力矩阵（**声明与预设，不是探测** —— 见 provider-capabilities.cjs 的 NOTE）：
       界面要能看出「这个模型支不支持 tool_call / 读图」；真要探测得上网，自检不联网，所以没做。 */
    capabilities: providerCaps.forProviders(c.providers),
    /** 品牌与旧命名，界面做迁移提示用 */
    brand: C.BRAND,
  }
}

/** 发请求时用这个：带 key 且启用的供应商 */
function activeProvider() {
  const enabled = load().providers.filter(kinds.usableProvider)
  return enabled.find((p) => hasKey(p)) ?? enabled[0] ?? null
}

/** 发**这个模型**时用哪个供应商（`activeProvider` 不看模型）；models 空 = 都能。
 *  `cfg` 可选：调用方手里已有配置（会话级模型注入后的那份）就传进来，保证两边同一份。 */
function providerForModel(model, cfg = load()) {
  const name = String(model ?? '').trim()
  if (!name) return activeProvider()
  /*
   * ★ 没有 Key 的后端（codex-cli）也算「可用」：它的推理走本机已登录的 CLI，
   *   Harbor 不存凭据。不加这条，用户选了它的模型会被**静默换掉**
   *   （pool 里只有别的供应商 → 落到 candidates[0]）—— 见 provider-kinds.cjs 文件头。
   */
  const enabled = cfg.providers.filter(kinds.usableProvider)
  const pool = enabled.filter((p) => hasKey(p) || !kinds.needsKey(p))
  const candidates = pool.length > 0 ? pool : enabled
  const serves = (p) => {
    const list = Array.isArray(p.models) ? p.models : []
    return list.length === 0 || list.includes(name)
  }
  return candidates.find(serves) ?? candidates[0] ?? null
}

/** 换供应商 / 删供应商时把密钥一起处理掉 */
function removeProviderSecrets(provider) {
  if (provider?.credentialRef) credentials.remove(provider.credentialRef)
}

function reset() {
  const fresh = normalize(null)
  /* 同 save：写成功才生效；写不进去时缓存还是旧的那份（旧文件也没被动过） */
  writeFile(fresh)
  cache = fresh
  return fresh
}

/** 诊断包用：报「加密了吗 / 几个凭证」，**不报值** */
function credentialsStatus() {
  return credentials.status()
}

/** 确保脱敏表里有全部密钥（启动时调） */
function primeSecrets() {
  return credentials.primeRedaction()
}

module.exports = {
  BRAND: C.BRAND,
  LEGACY: C.LEGACY,
  DEFAULTS: C.DEFAULTS,
  get,
  load,
  save,
  patch,
  forRenderer,
  activeProvider,
  providerForModel,
  hasKey,
  providerKey,
  searchKey,
  removeProviderSecrets,
  credentialsStatus,
  primeSecrets,
  reset,
  normalize,
  redact,
  _path: () => path.dirname(configFile()),
}
