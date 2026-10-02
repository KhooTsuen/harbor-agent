/**
 * 判据的「判决」形状：**pass / fail / unknown**，而且**必须带证据**。
 *
 * 为什么要有这个模块（2026-10-02 用户指定，见 `docs/判据自检.md`）：
 * 这个月撞到三次「判据自己出问题」：
 *   · **假红**：T10 判据用词表代替「说清没有」，把「说明.md 会从 6 行变成 20 行左右」
 *     判成「没说清风险」—— detail 里又没带它看到的东西，只能靠猜；
 *   · **假绿**：T1 在模型一次都没答上来时，按「文件没被动」判 ✅；
 *   · **假红**：自检那条「删完数量回到原样」数的是共享目录的既有条目。
 *
 * 三条规矩：
 *   ① `evidence` 是必填的 —— 判据得交出**它看到的事实**（哈希 / 计数 / 原文片段），
 *      否则无法区分「被测对象没做」和「判据看不见」；
 *   ② 观测不到的场合一律 `unknown`，**既不算过也不算不过**（退出码仍非 0，但字样不同）；
 *   ③ 老写法 `{ pass, detail }` 仍然认（自动补 evidence 并归一成 pass/fail）——
 *      逐条迁移，不必一次改完。
 */

/** 判据能给出的三种结局 */
export const OUTCOMES = ['pass', 'fail', 'unknown']

/** 过 / 不过 / 观测不到 */
export const pass = (detail, evidence) => ({ outcome: 'pass', detail, evidence })
export const fail = (detail, evidence) => ({ outcome: 'fail', detail, evidence })
export const unknown = (detail, evidence) => ({ outcome: 'unknown', detail, evidence })

/**
 * 归一：认老写法 `{ pass, detail }`，并保证 outcome/evidence 都在。
 * 返回 `{ outcome, detail, evidence }`。
 */
export function normalize(v = {}) {
  const outcome = OUTCOMES.includes(v.outcome) ? v.outcome : v.pass === true ? 'pass' : 'fail'
  return {
    outcome,
    detail: String(v.detail ?? ''),
    evidence: String(v.evidence ?? ''),
  }
}

/**
 * 「这一轮到底有没有真的跑到模型」—— 观测不到就别判。
 *
 * 输入是驱动能便宜拿到的东西（我全都要**观测**，不是靠猜）：
 *   · `timedOut`      这一轮撞了驱动的截止时间 → 产物必然不完整
 *   · `logSlice`      这一轮的日志片段（驱动按轮计时切好的）
 *   · `steps`         任务台账里这一轮的步骤（要 `ask_user` 之类的证据也从这儿来）
 *
 * 命中任一条就返回一个 `unknown` 判决（带上证据），否则返回 `null` 表示「可以正常判」。
 */
export function observeRound({ timedOut = false, logSlice = '', steps = [] } = {}) {
  if (timedOut) {
    return unknown('这一轮撞了驱动的截止时间（产物不完整，不判）', 'timedOut=true')
  }
  if (/凭证解密失败/.test(logSlice)) {
    return unknown('模型根本没跑起来：凭证解不开', '日志里出现「凭证解密失败」')
  }
  if (!/请求模型/.test(logSlice)) {
    return unknown('这一轮没有发出过模型请求（可能被前置拦下）', '日志里没有「请求模型」')
  }
  if (steps.length === 0) {
    return unknown('任务台账里这一轮一条步骤都没有（模型没动过手）', 'steps.length=0')
  }
  return null
}

/** 汇总一组判决：数一遍三种结局（供报告的汇总段与退出码用） */
export function tally(rows, key = '结局') {
  const out = { pass: 0, fail: 0, unknown: 0 }
  for (const r of rows) {
    const o = r[key]
    if (o in out) out[o] += 1
  }
  return out
}
