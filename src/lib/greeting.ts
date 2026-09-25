/* ══════════════════════════════════════════════════════════════
   开屏「性格层」的文案库与抽取规则（设计文档 §23.3–23.8）

   两层的分工是硬的：
     · 状态层说「现在真实发生了什么」（工作区 / 任务 / 测试）—— 必真、必在；
     · 性格层只负责让界面不冷 —— 可以随机、可以关，**不能与状态冲突**，
       也不能声称任何没有验证过的事情。

   规则（§23.8）：
     · 每次开屏最多一条；
     · 同一句要隔 ≥5 次开屏**或** ≥24 小时才可能再出现；
     · 出错 / 权限等待 / 凭证问题时不出吐槽句（由调用方传 normal:false）；
     · 深夜（0-5 点）只出深夜句库的句子（不鼓励熬夜）。

   抽取是纯函数（rand 可注入）—— 单测不碰真实随机数。
   ══════════════════════════════════════════════════════════════ */

export type GreetingKind = 'welcome' | 'revisit' | 'quip' | 'night'

export interface Greeting {
  id: string
  kind: GreetingKind
  text: string
}

export interface GreetingUse {
  id: string
  at: number
  /** 第几次开屏用的（配合「间隔 5 次」的规则） */
  open: number
}

export const OPEN_GAP = 5
export const DAY_MS = 24 * 60 * 60 * 1000
/** 深夜时段：00:00–05:00（本地时间；不请求定位，不看天气） */
export const NIGHT_HOUR_END = 5

const WELCOME: Greeting[] = [
  { id: 'w1', kind: 'welcome', text: '来了？今天想折腾点什么。' },
  { id: 'w2', kind: 'welcome', text: '醒着呢。说吧，我接。' },
  { id: 'w3', kind: 'welcome', text: '又见面了。这次带问题，还是带情绪？' },
  { id: 'w4', kind: 'welcome', text: '工作区在这儿，先挑一件。' },
  { id: 'w5', kind: 'welcome', text: '今天准备修点什么？' },
  { id: 'w6', kind: 'welcome', text: '你负责说，我负责把现场看明白。' },
  { id: 'w7', kind: 'welcome', text: '还没开工。正好，先从最麻烦的那件开始？' },
  { id: 'w8', kind: 'welcome', text: '文件都在，别急着改。' },
  { id: 'w9', kind: 'welcome', text: '港口开着，把问题丢过来。' },
  { id: 'w10', kind: 'welcome', text: '今天也不一定要一次解决所有事。' },
  { id: 'w11', kind: 'welcome', text: '先来一个小任务热热身？' },
  { id: 'w12', kind: 'welcome', text: '想查、想改、想吐槽，都可以先说。' },
  { id: 'w13', kind: 'welcome', text: '这次从哪里下手？' },
]

const REVISIT: Greeting[] = [
  { id: 'r1', kind: 'revisit', text: '又回来了。上次那件事还在等你。' },
  { id: 'r2', kind: 'revisit', text: '你上次停在这里，要接着走吗？' },
  { id: 'r3', kind: 'revisit', text: '昨天的坑还在，今天要不要填一铲？' },
  { id: 'r4', kind: 'revisit', text: '看起来你还没打算放过这个项目。' },
  { id: 'r5', kind: 'revisit', text: '上次改到一半，这次继续？' },
  { id: 'r6', kind: 'revisit', text: '这份代码还认得你。' },
  { id: 'r7', kind: 'revisit', text: '欢迎回来，现场没有自己消失。' },
]

const QUIP: Greeting[] = [
  { id: 'q1', kind: 'quip', text: '这个项目的脾气，今天看起来还行。' },
  { id: 'q2', kind: 'quip', text: '变更不算多，适合先看一眼。' },
  { id: 'q3', kind: 'quip', text: '测试还没跑，谁也不能提前庆祝。' },
  { id: 'q4', kind: 'quip', text: '文件很多，但我们可以一件一件来。' },
  { id: 'q5', kind: 'quip', text: '这段代码看着像是有故事。' },
  { id: 'q6', kind: 'quip', text: '先别急着重构，听它解释一下。' },
  { id: 'q7', kind: 'quip', text: '这里安静得有点可疑。' },
  { id: 'q8', kind: 'quip', text: '没有 TODO？今天运气不错。' },
]

const NIGHT: Greeting[] = [
  { id: 'n1', kind: 'night', text: '还没睡？那就先做最小的一步。' },
  { id: 'n2', kind: 'night', text: '夜班港口还开着，但别把自己也留在这儿。' },
  { id: 'n3', kind: 'night', text: '可以继续，也可以明天再处理。' },
  { id: 'n4', kind: 'night', text: '先记下来，明天接着做也行。' },
]

export const ALL_GREETINGS: Greeting[] = [...WELCOME, ...REVISIT, ...QUIP, ...NIGHT]

/** 按上下文挑出候选池（深夜只看深夜句；有历史才用回访句；非普通状态不出吐槽） */
export function greetingPool(input: {
  night: boolean
  hasHistory: boolean
  normal: boolean
}): Greeting[] {
  if (input.night) return [...NIGHT]
  const pool = input.hasHistory ? [...REVISIT, ...WELCOME] : [...WELCOME]
  if (input.normal) pool.push(...QUIP)
  return pool
}

export interface GreetingPickInput {
  now: Date
  /** 这台机器上有历史（会话/任务）—— 允许回访句 */
  hasHistory: boolean
  /** 普通就绪（无阻断：没在报错、没有待确认权限、扫描正常）—— 允许吐槽句 */
  normal: boolean
  recent: GreetingUse[]
  /** 这是第几次开屏（1 起） */
  opens: number
  rand?: () => number
}

/** 被「间隔」挡住：既没隔够 5 次开屏，又没隔够 24 小时 */
function isBlocked(use: GreetingUse, opens: number, nowMs: number): boolean {
  return opens - use.open < OPEN_GAP && nowMs - use.at < DAY_MS
}

export function pickGreeting(input: GreetingPickInput): Greeting | null {
  const nowMs = input.now.getTime()
  const pool = greetingPool({
    night: input.now.getHours() < NIGHT_HOUR_END,
    hasHistory: input.hasHistory,
    normal: input.normal,
  })
  if (!pool.length) return null
  /* 先按「间隔」严格过滤；全被挡住就宁可不出，也不违背规则 */
  const candidates = pool.filter(
    (g) => !input.recent.some((use) => use.id === g.id && isBlocked(use, input.opens, nowMs)),
  )
  if (!candidates.length) return null
  const rand = input.rand ?? Math.random
  const index = Math.min(candidates.length - 1, Math.floor(rand() * candidates.length))
  return candidates[index]
}
