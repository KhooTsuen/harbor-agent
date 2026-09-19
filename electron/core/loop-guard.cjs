/**
 * 重复执行检测（AG-041 Loop Detection）
 *
 * 文档给的图形最说明问题：
 *
 *   Tool A → Tool B → Tool A → Tool B → Tool A → Tool B
 *
 * 这种「转圈」不比「同一个工具连调三次」显眼，但一样是卡住了：
 * 每次调用单看都合理，合起来看是原地打转。检测到之后：
 *
 *   检测到 Agent 可能陷入重复执行。
 *   正在重新规划任务…
 *
 * 再超过阈值就**请求用户介入**（停下来，别让它在循环里烧 token）。
 *
 * ── 三条判断 ──
 *   ① 同一个调用（工具 + 参数）连续重复
 *   ② 周期重复：A B A B（周期 2）、A B C A B C（周期 3）
 *   ③ 只在这些情况**且**已经没进展时才拦 —— 判断交给调用方（它知道轮次与计划）
 *
 * ── 为什么按「工具 + 参数」而不是只按工具名 ──
 * 连续读十个不同的文件是正常干活（AG-019 的缓存就是为了让它便宜），
 * 只有「一模一样的调用」才叫卡住。参数要归一化：对象键顺序不同算同一个调用。
 */

/** 看最近多少个调用（够看出周期就行，太长反而把正常的长串误判） */
const WINDOW = 12
/** 同一个调用连续几次算重复 */
const REPEAT_LIMIT = 3
/** 周期最大认到几（A B / A B C） */
const MAX_PERIOD = 3
/** 周期至少重复几遍才算转圈（两遍是「碰巧」，三遍才是「在转」） */
const CYCLE_ROUNDS = 3

/** 参数归一化：键排序 + 截断长值。同一个调用必须得同一个字符串 */
function stableArgs(args) {
  if (args === undefined || args === null) return ''
  try {
    const walk = (value) => {
      if (Array.isArray(value)) return value.map(walk)
      if (value && typeof value === 'object') {
        const out = {}
        for (const key of Object.keys(value).sort()) out[key] = walk(value[key])
        return out
      }
      if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value
      return value
    }
    return JSON.stringify(walk(args))
  } catch {
    return ''
  }
}

/** 一次调用的签名：工具名 + 归一化参数 */
function signatureOf(run) {
  return `${String(run?.name ?? '')}(${stableArgs(run?.args)})`
}

function signaturesOf(runs) {
  return (runs ?? []).map(signatureOf)
}

/**
 * 看这一串签名有没有在转圈。
 *
 * @param {string[]} signatures
 * @returns {{ looping: boolean, kind?: 'repeat'|'cycle', period?: number, count?: number, samples?: string[] }}
 */
function detect(signatures) {
  const list = (signatures ?? []).slice(-WINDOW)
  const none = { looping: false }
  if (list.length < REPEAT_LIMIT) return none

  /* ① 同一个调用连着来 */
  let tail = 1
  for (let i = list.length - 2; i >= 0 && list[i] === list[list.length - 1]; i -= 1) tail += 1
  if (tail >= REPEAT_LIMIT) {
    const last = list[list.length - 1]
    return { looping: true, kind: 'repeat', period: 1, count: tail, samples: [last] }
  }

  /* ② 周期重复：取尾巴上的 2..MAX_PERIOD 个当周期，看它重复了几遍 */
  for (let period = 2; period <= MAX_PERIOD; period += 1) {
    const need = period * CYCLE_ROUNDS
    if (list.length < need) continue
    const block = list.slice(-period)
    /* 周期内部不能自己就相等（A A A 那种已经在①里抓了） */
    if (new Set(block).size < 2) continue
    let rounds = 0
    for (let end = list.length; end - period >= 0; end -= period) {
      const chunk = list.slice(end - period, end)
      if (chunk.join('\u0000') !== block.join('\u0000')) break
      rounds += 1
    }
    if (rounds >= CYCLE_ROUNDS) {
      return { looping: true, kind: 'cycle', period, count: rounds * period, samples: block }
    }
  }

  return none
}

/** 说人话：把签名里的参数截短一点，别在提示里糊一大坨 JSON */
function describe(samples) {
  return (samples ?? [])
    .map((sample) => {
      const text = String(sample)
      return text.length > 60 ? `${text.slice(0, 60)}…` : text
    })
    .join(' → ')
}

/**
 * 给模型的「改道」提示。
 *
 * 和完成门禁同一个路子（见 task-context.cjs 的 shouldContinue）：
 * 不直接判死刑，先把话说清楚、让它**换法子**；连着几次不听才交给人。
 */
function nudgeMessage(detection) {
  const what =
    detection.kind === 'repeat'
      ? `同样的调用连着来了 ${detection.count} 次`
      : `这 ${detection.period} 个调用已经重复了 ${detection.count / detection.period} 遍`
  return [
    `检测到你可能陷入重复执行：${what}。`,
    `重复的是：${describe(detection.samples)}`,
    '',
    '先别继续按老路子试了，重新规划一下：',
    '· 说明你**想达成什么**，以及刚才那几步为什么没成',
    '· 换一个办法（换个工具、先读清楚再动、缩小范围），或者',
    '· 如果这事其实做不到 / 需要用户提供信息，就直接说出来',
    '用 ```plan 块给出更新后的计划再继续。',
  ].join('\n')
}

module.exports = {
  detect,
  signatureOf,
  signaturesOf,
  nudgeMessage,
  stableArgs,
  WINDOW,
  REPEAT_LIMIT,
  MAX_PERIOD,
  CYCLE_ROUNDS,
}
