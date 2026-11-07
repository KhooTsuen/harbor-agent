/**
 * 用量查询的 IPC（`usage:query`）
 *
 * 状态与口径全在内核：`core/usage-query.cjs`（各维度语义、未知/旧格式怎么分）。
 * 这里只做三件事：**校验入参 → 调内核 → 把结果原样送回去**。
 *
 * ── 为什么入参要在这里校验 ────────────────────────────────────
 *
 * 渲染层传什么都可能（数字是字符串 / null / 超长数组）。内核那边是纯函数、
 * 不做防御；放进来直接把 `from: 'abc'` 传下去，`Number('abc')` 变成 NaN，
 * 筛选条件悄悄失效 —— 用户看到的是「筛了和没筛一样」，而且不报错。
 * 所以这里**只放行已知字段**，类型不对就丢掉（不是猜测补默认值）。
 */

const log = require('../core/log.cjs')
const usageQuery = require('../core/usage-query.cjs')

/** 合法的时间戳：正数且不超过 2100 年（更大的值一定是传错了） */
const MAX_TS = 4102444800000

function ts(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_TS) return 0
  return Math.floor(n)
}

function text(value, max = 120) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/** 白名单式清洗：只认下面这些字段，别的一律不进内核 */
function sanitize(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const out = {
    from: ts(input.from),
    to: ts(input.to),
    providerId: text(input.providerId),
    model: text(input.model),
    taskId: text(input.taskId),
    sessionId: text(input.sessionId),
    purpose: text(input.purpose, 32),
    includeEmptyDays: input.includeEmptyDays === true,
  }
  /* 入口只有两种取值，别的当「不筛」而不是猜成 api */
  if (input.entry === 'api' || input.entry === 'cli') out.entry = input.entry
  /* 原始行只在明确要求时给（数据量大，别默认走 IPC 通道） */
  if (input.withRows === true) out.withRows = true
  return out
}

function register({ ipcMain }) {
  ipcMain.handle('usage:query', async (_event, raw) => {
    try {
      const result = await usageQuery.query(sanitize(raw))
      return { ok: true, result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`用量查询失败：${message}`)
      /*
       * ★ 失败必须 `ok:false` + 说明，**不能**返回一个空统计当成功：
       *   「0 次请求」和「查不出来」在界面上长得一样，但后者会让人以为没花钱。
       */
      return { ok: false, error: message }
    }
  })

  /* 语义常量（界面拿它决定文案：缓存含在输入里、时区按本地…） */
  ipcMain.handle('usage:semantics', () => ({ ok: true, semantics: usageQuery.SEMANTICS }))
}

module.exports = { register, sanitize }
