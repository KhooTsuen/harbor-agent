/**
 * 定时任务台账：落盘 data/schedules.json
 *
 * 形状：`{ version: 1, items: [...] }`（和别的台账一样带 version，将来加字段好迁移）
 *
 * 三个刻意的决定：
 *
 * ① **写盘用原子替换**（先写临时文件再 rename）。定时任务是后台跑的，
 *    正好在写盘那一刻被关机 / 被杀，一个半截的 JSON 会让整个列表读不出来。
 *    `task-io.cjs` 那边是直接 writeFileSync —— 这里不照抄，因为那边写坏一个
 *    任务只丢一条，这里写坏是**全丢**（所有条目在同一个文件里）。
 *
 * ② **绝不接受看着像密钥的内容**。提示词每一轮都会进上下文，混一个 key 进去
 *    等于每轮都在泄露它（这条规矩在 memory-store.cjs 里已经有一份，这里复用）。
 *
 * ③ `workdir` 不存在不是错误，是**回落成空串**。用户可能在 A 机器上建了任务，
 *    换到 B 机器上跑（同一份 data/）—— 因为目录不在就拒绝保存，任务会凭空消失；
 *    回落成默认工作目录，任务还能跑。
 *
 * 测试怎么不碰真实数据：`setFilePathForTest()` 把路径指到别处（名字就写清楚了
 * 它是给测试用的，别在业务代码里调）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const redact = require('./redact.cjs')
const { SECRET_LIKE } = require('./memory-schema.cjs')
const { validateWhen } = require('./schedule-next.cjs')
const { GRANTS } = require('./schedule-grant.cjs')

const VERSION = 1
const NAME_MAX = 60
const PROMPT_MAX = 2000

/** recordRun 认的字段。别的字段只能走 save()（那条路上有全部校验） */
const RUN_FIELDS = [
  'lastRunAt',
  'lastTaskId',
  'lastResult',
  'runCount',
  'blockedCount',
  /* 执行器第一次跑时会给任务建一个专属会话，id 要记下来 —— 下次接着用同一个 */
  'sessionId',
]

/** 测试注入的路径；空串 = 用真实路径 */
let overridePath = ''

function filePath() {
  return overridePath || path.join(DIRS.data, 'schedules.json')
}

/** 把台账指到别的文件（**只给测试用**）。传空串还原 */
function setFilePathForTest(target) {
  overridePath = typeof target === 'string' ? target : ''
  return filePath()
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function empty() {
  return { version: VERSION, items: [] }
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter((item) => item && typeof item.id === 'string' && item.id)
      : []
    if (Array.isArray(parsed.items) && items.length !== parsed.items.length) {
      log.warn(`定时任务台账里有 ${parsed.items.length - items.length} 条读不出 id，已跳过`)
    }
    return { version: VERSION, items }
  } catch (error) {
    /* 文件还不存在是正常的（一条都没建过）；别的错得让人看见 */
    if (error?.code !== 'ENOENT') log.warn(`读定时任务台账失败：${messageOf(error)}`)
    return empty()
  }
}

/** 原子写：先写临时文件再 rename（rename 是替换，不是追加） */
function persist(data) {
  const target = filePath()
  const temp = `${target}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(temp, target)
}

/** 给调用方的是副本：外面改了不该影响内存/文件里的那份 */
function clone(item) {
  return { ...item, when: { ...(item.when ?? {}) } }
}

function newId() {
  return `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** 看着像密钥吗（两道：记忆那套前缀 + 全局脱敏的模式表） */
function looksLikeSecret(text) {
  const sample = String(text ?? '')
  if (!sample) return false
  return SECRET_LIKE.test(sample) || redact.looksSecret(sample)
}

/** 目录不存在 → 回落空串（= 用默认工作目录），这不算错误 */
function resolveWorkdir(value) {
  const dir = String(value ?? '').trim()
  if (!dir) return ''
  try {
    return fs.statSync(dir).isDirectory() ? dir : ''
  } catch {
    return ''
  }
}

/** 全部条目（按创建时间排，稳定） */
function list() {
  return load()
    .items.slice()
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || (a.id < b.id ? -1 : 1))
    .map(clone)
}

/** 一条；没有返回 null */
function get(id) {
  const item = load().items.find((entry) => entry.id === id)
  return item ? clone(item) : null
}

/**
 * 新建或更新。有 id 就更新、没 id 就新建。
 *
 * @returns {{ ok: boolean, item?: object, error?: string }}
 */
function save(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const store = load()

  const wanted = typeof raw.id === 'string' ? raw.id : ''
  const existing = wanted ? store.items.find((entry) => entry.id === wanted) ?? null : null
  /* 带了 id 却找不到 → 报错而不是当新建：前端拿的是一份旧列表时，
     静默新建会凭空多出一条一模一样的任务 */
  if (wanted && !existing) return { ok: false, error: '这条定时任务已经不在了（可能被删了）' }

  const name = String(raw.name ?? existing?.name ?? '').trim()
  if (!name) return { ok: false, error: '名字不能为空' }
  if (name.length > NAME_MAX) return { ok: false, error: `名字最多 ${NAME_MAX} 个字` }

  const prompt = String(raw.prompt ?? existing?.prompt ?? '').trim()
  if (!prompt) return { ok: false, error: '提示词不能为空' }
  if (prompt.length > PROMPT_MAX) return { ok: false, error: `提示词最多 ${PROMPT_MAX} 字` }

  /*
   * ★ 密钥不进提示词。提示词每轮都进上下文，混一个 key 等于每轮都在泄露它 ——
   *   而定时任务是**没人看着**在跑，泄露了也不会有人当场发现。
   */
  if (looksLikeSecret(prompt) || looksLikeSecret(name)) {
    return {
      ok: false,
      error:
        '这段内容看起来是密钥 / 令牌，没有保存。定时任务的提示词每一轮都会进上下文，' +
        '密钥请放在「设置 → 模型」的凭证里，不要写进提示词。',
    }
  }

  const when = raw.when ?? existing?.when
  const checked = validateWhen(when)
  if (!checked.ok) return { ok: false, error: checked.error }

  const grant = raw.grant ?? existing?.grant
  if (!GRANTS.includes(grant)) return { ok: false, error: `权限档只能是 ${GRANTS.join(' / ')}` }

  const item = {
    id: existing?.id ?? newId(),
    name,
    when: { ...when },
    prompt,
    workdir: resolveWorkdir(raw.workdir ?? existing?.workdir),
    grant,
    enabled: raw.enabled === undefined ? (existing ? existing.enabled === true : true) : raw.enabled === true,
    createdAt: Number(existing?.createdAt) || Date.now(),
    lastRunAt: Number(existing?.lastRunAt) || 0,
    lastTaskId: String(existing?.lastTaskId ?? ''),
    lastResult: String(existing?.lastResult ?? ''),
    runCount: Number(existing?.runCount) || 0,
    blockedCount: Number(existing?.blockedCount) || 0,
    sessionId: String(existing?.sessionId ?? ''),
  }

  const items = existing
    ? store.items.map((entry) => (entry.id === existing.id ? item : entry))
    : [...store.items, item]

  try {
    persist({ version: VERSION, items })
  } catch (error) {
    return { ok: false, error: `保存失败：${messageOf(error)}` }
  }
  return { ok: true, item: clone(item) }
}

/** 删一条 */
function remove(id) {
  const store = load()
  const items = store.items.filter((entry) => entry.id !== id)
  if (items.length === store.items.length) return { ok: false, error: '没有这条定时任务' }
  try {
    persist({ version: VERSION, items })
  } catch (error) {
    return { ok: false, error: `删除失败：${messageOf(error)}` }
  }
  return { ok: true }
}

/** 开 / 关（开关是最常用的操作，不值得为此走一遍完整校验） */
function setEnabled(id, enabled) {
  const store = load()
  const index = store.items.findIndex((entry) => entry.id === id)
  if (index < 0) return { ok: false, error: '没有这条定时任务' }
  store.items[index] = { ...store.items[index], enabled: enabled === true }
  try {
    persist(store)
  } catch (error) {
    return { ok: false, error: `保存失败：${messageOf(error)}` }
  }
  return { ok: true, item: clone(store.items[index]) }
}

/** 把一次运行的结果写回台账；只认 RUN_FIELDS，别的字段一律忽略 */
function recordRun(id, patch = {}) {
  const store = load()
  const index = store.items.findIndex((entry) => entry.id === id)
  if (index < 0) return { ok: false, error: '没有这条定时任务' }

  const item = { ...store.items[index] }
  for (const field of RUN_FIELDS) {
    if (!(field in patch)) continue
    item[field] = normalizeField(field, patch[field])
  }
  store.items[index] = item
  try {
    persist(store)
  } catch (error) {
    return { ok: false, error: `保存失败：${messageOf(error)}` }
  }
  return { ok: true, item: clone(item) }
}

function normalizeField(field, value) {
  if (field === 'lastRunAt' || field === 'runCount' || field === 'blockedCount') {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
  }
  return String(value ?? '')
}

module.exports = {
  VERSION,
  NAME_MAX,
  PROMPT_MAX,
  filePath,
  setFilePathForTest,
  list,
  get,
  save,
  remove,
  setEnabled,
  recordRun,
}
