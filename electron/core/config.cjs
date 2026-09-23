/**
 * 配置：读写
 *
 * 只负责「存取 + 迁移 + 给界面安全版本」。字段校验在 config-normalize.cjs，
 * 默认值在 config-defaults.cjs。
 *
 * **这里最重要的一条：apiKey 不落这个文件。**
 * 老配置里的明文 key 会在首次加载时被搬进凭证库（credentials.cjs）
 * 并从文件里抹掉。界面看到的永远是掩码 + `hasKey`。
 */

const fs = require('node:fs')
const path = require('node:path')
const { configFile, DIRS } = require('./paths.cjs')
const C = require('./config-defaults.cjs')
const { normalize } = require('./config-normalize.cjs')
const log = require('./log.cjs')
const credentials = require('./credentials.cjs')
const redact = require('./redact.cjs')

let cache = null

/**
 * 把老版本遗留下来的明文密钥搬进凭证库。
 *
 * 只做搬运，不做删除判断 —— 搬完清空原字段，落盘时就不会再写出去。
 * @returns {{ moved: number, refs: string[] }}
 */
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
     * 配置读不出来时，**先把现场留一份**再回退默认值。
     *
     * 不这么做的话：启动后的某次设置同步会把坏文件覆盖成默认值 ——
     * 用户原来的 provider 列表、工作目录、快捷键全部静默消失，
     * 而且没有任何提示。这是破坏性测试实测出来的（截断 config.json
     * 后启动，providers 从 2 个变 1 个、workdir 被清空）。
     *
     * 注意 credentials.json 那边的做法更好（坏文件原样不动），
     * 配置这边做不到「不回写」—— 设置改一次就要写一次 —— 所以退而求其次：
     * 至少让原文件活在一份 .broken-<时间戳> 里，并且让界面能提示用户。
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
  fs.writeFileSync(configFile(), JSON.stringify(stripInternal(cfg), null, 2), 'utf8')
}

function save(next) {
  const merged = normalize(next ?? cache)
  merged.updatedAt = Date.now()
  migrateLegacySecrets(merged)
  cache = merged
  writeFile(merged)
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
    mcp: partial.mcp ?? current.mcp,
    scenes: { ...current.scenes, ...(partial.scenes ?? {}) },
    providers: partial.providers ?? current.providers,
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

/**
 * 给界面用的版本。
 *
 * **必须把密钥藏掉**：这里返回的 apiKey 永远是掩码，
 * 真实值只在主进程发请求时取。
 */
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
    /** 品牌与旧命名，界面做迁移提示用 */
    brand: C.BRAND,
  }
}

/** 发请求时用这个：带 key 且启用的供应商 */
function activeProvider() {
  const c = load()
  const enabled = c.providers.filter((p) => p.enabled && p.baseUrl)
  return enabled.find((p) => hasKey(p)) ?? enabled[0] ?? null
}

/** 发**这个模型**时该用哪个供应商（activeProvider 不看模型）；models 为空 = 没声明 → 当作「都能」 */
function providerForModel(model) {
  const name = String(model ?? '').trim()
  if (!name) return activeProvider()
  const c = load()
  const enabled = c.providers.filter((p) => p.enabled && p.baseUrl)
  const pool = enabled.filter((p) => hasKey(p))
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
  cache = null
  const fresh = normalize(null)
  cache = fresh
  writeFile(fresh)
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
