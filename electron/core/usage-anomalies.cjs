/**
 * 用量账本的**异常检查**（保守派：只报能确证的问题）
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────
 * `usage-query.cjs` 已经 300 行；而且「聚合」和「体检」是两件事：
 * 聚合回答「多少」，体检回答「这些数字可不可信」。混在一起以后谁都改不动。
 *
 * ── 只报四类，且都能给出证据 ────────────────────────────────────
 *
 *   1. `duplicates`    同一 (trace, retryIndex) 出现多次，且这几行的
 *                      providerId / model / at 完全相同 —— 重试是**不同**
 *                      retryIndex，所以这种多半是重复记账（append 两次）。
 *   2. `badValues`     任何数值字段是负数或非有限数。上游给脏值时，
 *                      `Number.isFinite` 早就把它变成 null 了；能漏到这里
 *                      的都是落盘阶段写坏的。
 *   3. `missingOutcome` 既没有 `ok` 也没有 `outcome` —— 这一行无法判断成败，
 *                      所以也算不进「已结束请求」的分子分母。
 *   4. `cacheOverflow` `cacheHit > prompt`。缓存命中含在 prompt 里（DeepSeek
 *                      的 hit+miss=prompt），命中比输入还多说明口径矛盾。
 *
 * ── 不报什么（很重要）──────────────────────────────────────────
 *   · 不报「token 总数看起来不对」—— 没有外部账单做基准时那是猜。
 *   · 不报「覆盖率低」—— 那是覆盖率本身，不是异常。
 *   · 不报「模型名不在能力表里」—— 中转站改名的怀疑论不在本阶段范围。
 *
 * ── `checked` 字段 ──────────────────────────────────────────────
 * 明确列出这次真跑过哪几项检查。界面据此显示「N 项已检查」；
 * **没跑过的检查不许显示成 0 个异常**（那等于暗示已经验证过了）。
 */

/** 数值字段：与 `usage-query.cjs` 的 NUMS 同一份口径 */
const NUMS = ['prompt', 'completion', 'total', 'cacheHit', 'cacheMiss', 'reasoning', 'cost']

const CHECKED = ['duplicates', 'badValues', 'missingOutcome', 'cacheOverflow']

/**
 * @param {Array<object>} rows 账本行（已按筛选过滤）
 * @returns {{ checked: string[], duplicates: number, badValues: number, missingOutcome: number,
 *             cacheOverflow: number, total: number, samples: Array<{kind: string, detail: string}> }}
 */
function checkRows(rows) {
  const seen = new Map()
  let duplicates = 0
  let badValues = 0
  let missingOutcome = 0
  let cacheOverflow = 0
  const samples = []

  const push = (kind, detail) => {
    if (samples.length < 5) samples.push({ kind, detail })
  }

  for (const row of rows) {
    /* ① 重复记账：trace + retryIndex 是同一次尝试的身份 */
    const trace = String(row.trace ?? '')
    if (trace) {
      const key = `${trace}\u0000${Number(row.retryIndex) || 0}\u0000${row.providerId ?? ''}\u0000${row.model ?? ''}`
      const at = Number(row.at) || 0
      const prev = seen.get(key)
      if (prev === undefined) {
        seen.set(key, at)
      } else if (prev === at) {
        /* 连时间戳都一样 —— 同一条记录被写了两次 */
        duplicates += 1
        push('duplicates', `${trace} 在 ${new Date(at).toISOString()} 出现了两次`)
      } else {
        /* 同一 trace 不同时间：可能是「重新生成」用了同一个 trace，不算重复 */
        seen.set(key, at)
      }
    }

    /* ② 脏数值 */
    for (const key of NUMS) {
      const value = row[key]
      if (value === null || value === undefined) continue
      if (!Number.isFinite(Number(value)) || Number(value) < 0) {
        badValues += 1
        push('badValues', `${key} = ${String(value)}`)
      }
    }

    /* ③ 判断不出成败 */
    if (row.ok === undefined && row.outcome === undefined) missingOutcome += 1

    /* ④ 缓存命中比输入还多（含在 prompt 内，不可能超过） */
    const hit = Number(row.cacheHit)
    const prompt = Number(row.prompt)
    if (Number.isFinite(hit) && Number.isFinite(prompt) && hit > prompt) {
      cacheOverflow += 1
      push('cacheOverflow', `cacheHit ${hit} > prompt ${prompt}`)
    }
  }

  return {
    checked: CHECKED.slice(),
    duplicates,
    badValues,
    missingOutcome,
    cacheOverflow,
    total: rows.length,
    samples,
  }
}

module.exports = { checkRows, CHECKED }
