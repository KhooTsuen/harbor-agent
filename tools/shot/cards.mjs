/**
 * 交互卡片的检测与自动点击（**只给自动化测试用**）
 *
 * 为什么需要它：CDP 脚本会自己填输入框、点发送，但界面上弹出**提问卡 / 确认卡**时
 * 它不知道该点哪儿 —— 于是对话卡在半路。看着像「模型没选对工具」，其实是脚本不会
 * 往下走（2026-10-14 实测：A/B 里几条场景就是这么卡住的）。这个模块补上这一步。
 *
 * 四种卡都挂在输入框上方（`AboveInputCards.tsx` 一个挂载点），靠 `aria-label` 认：
 *   · 确认卡 `等待确认`       （PermissionBar）取消 / 允许本次
 *   · 澄清卡 `开工前先对齐`   （ClarifyCard）  选项 + 就这么干 / 跳过 / 换说法 / 先不做了
 *   · 复核卡 `执行前复核`     （GateCard）    两个选项直接提交（内核只认 label）
 *   · 只读卡 `当时问过的问题` （回看历史，不可点 —— 这里**不碰**）
 *
 * ★ 选择器与按钮文案照抄渲染层（上面三个 `.tsx` 的 `aria-label` / 按钮文字）。
 *   渲染层改了这里就得同步 —— 否则脚本会**悄悄失效**（改了文案，脚本照跑不误、却点不动）。
 * ★ 纯测试工具：不 import 任何产品代码，只往页面发 CDP 表达式。
 */

import { evaluate, sleep } from './cdp.mjs'

/** 三种**可点**的交互卡：用途 → 渲染层的 `aria-label` */
export const CARDS = {
  confirm: '等待确认',
  clarify: '开工前先对齐',
  gate: '执行前复核',
}
/** 只读的历史卡（`ClarifyCard` 的回看态）：**绝不去点它** */
export const READONLY_CARD = '当时问过的问题'

/** 每种卡的默认提交按钮（按顺序试，先命中的先点） */
const SUBMIT = {
  [CARDS.confirm]: ['允许'],
  [CARDS.clarify]: ['就这么干'],
  [CARDS.gate]: ['就按这个计划执行'],
}

/* 当前**可见**的活动卡。`hidden` 收起来的不算 —— AboveInputCards 用 hidden 藏另一张 */
const ACTIVE_EXPR = `[...document.querySelectorAll('section[aria-label]')].filter(s=>${JSON.stringify(
  Object.values(CARDS),
)}.indexOf(s.getAttribute('aria-label'))>=0&&s.offsetParent!==null)`

/** 读活动卡状态：没有卡 → null；有 → { label, buttons } */
export const CARD_STATE = `(function(){const c=${ACTIVE_EXPR};if(!c.length)return null;const el=c[0];return{label:el.getAttribute('aria-label'),buttons:[...el.querySelectorAll('button')].map(b=>(b.textContent||'').trim().slice(0,40))}})()`

/** 活动卡里按**可访问文案**点按钮（textContent 或 aria-label 命中即可） */
function clickExpr(text) {
  return `(function(){const cards=${ACTIVE_EXPR};if(!cards.length)return{clicked:false,reason:'no-card'};const want=${JSON.stringify(
    text,
  )};for(const c of cards){const b=[...c.querySelectorAll('button')].find(x=>((x.textContent||'')+(x.getAttribute('aria-label')||'')).includes(want));if(b){b.click();return{clicked:true,card:c.getAttribute('aria-label'),text:(b.textContent||'').trim().slice(0,40)}}}return{clicked:false,reason:'no-button'}})()`
}

/** 兼容旧引用（`tools/smoke/kit.mjs` 原先自己抄过一份）：确认卡在不在 */
export const CONFIRM_CARD = `!!document.querySelector('section[aria-label="${CARDS.confirm}"]')`
/** 兼容旧引用：点确认卡的「允许本次」，**返回 boolean**（旧调用方判 `=== true`） */
export const APPROVE = `(function(){const c=document.querySelector('section[aria-label="${CARDS.confirm}"]');if(!c)return false;const b=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes('允许'));if(!b)return false;b.click();return true})()`

/** 传进来的可以是 cdp 连接（有 `.send`），也可以是已经包好的 `(expr,label)=>...` */
function evOf(target) {
  if (typeof target === 'function') return target
  return (expr, label) => evaluate(target, expr, { label })
}

/** 当前可见的活动卡（没有就是 null） */
export async function detectCard(target) {
  const ev = evOf(target)
  return (await ev(CARD_STATE, '读交互卡状态')) ?? null
}

/**
 * 在当前活动卡里按可访问文案点一个按钮。
 * 卡不在（`reason:'no-card'`）会立刻返回 —— 调用方据此知道「这轮没卡」。
 * @returns {Promise<{clicked:boolean, card?:string, text?:string, reason?:string}>}
 */
export async function clickInteractiveCard(target, text, { timeoutMs = 4000, intervalMs = 400 } = {}) {
  const ev = evOf(target)
  const deadline = Date.now() + timeoutMs
  let last = { clicked: false, reason: 'timeout' }
  while (Date.now() < deadline) {
    last = await ev(clickExpr(text), `点卡片按钮「${text}」`)
    if (last?.clicked || last?.reason === 'no-card') return last
    await sleep(intervalMs)
  }
  return last
}

/** 等卡片出现（没出现返回 null）。发完消息后用它 —— 不像确认卡那样立刻弹。 */
export async function waitForCard(target, { timeoutMs = 60000, intervalMs = 600 } = {}) {
  const ev = evOf(target)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const card = await detectCard(ev)
    if (card) return card
    await sleep(intervalMs)
  }
  return null
}

/** 等卡片消失（点了按钮之后不该一直挂着） */
export async function waitForCardGone(target, { timeoutMs = 10000, intervalMs = 400 } = {}) {
  const ev = evOf(target)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await detectCard(ev))) return true
    await sleep(intervalMs)
  }
  return false
}

/**
 * 「检测 → 点掉」反复做，直到界面上没有可点的卡（自动化测试的主力入口）。
 *
 * @param {object|Function} target cdp 连接或 `(expr,label)=>...`
 * @param {{ choose?: string, timeoutMs?: number, maxCards?: number }} [opts]
 *   `choose` —— 澄清卡先点的那个**选项**文案（如「选项 A」）；不给就直接提交
 * @returns {Promise<{handled:number, clicks:Array, stuck:object|null}>}
 *   `stuck` 非空 = 认出了卡却点不动（文案变了 / 按钮不在卡内）—— 那是脚本该修的信号
 */
export async function autoAnswerCards(target, { choose = '', timeoutMs = 15000, maxCards = 4 } = {}) {
  const ev = evOf(target)
  const deadline = Date.now() + timeoutMs
  const clicks = []
  while (Date.now() < deadline && clicks.length < maxCards) {
    const card = await detectCard(ev)
    if (!card) return { handled: clicks.length, clicks, stuck: null }
    /* 澄清卡：先点一个选项（用户真实操作就是先选、再提交） */
    if (choose && card.label === CARDS.clarify) {
      const picked = await clickInteractiveCard(ev, choose, { timeoutMs: 2500 })
      if (picked?.clicked) clicks.push(picked)
    }
    let submitted = null
    for (const text of SUBMIT[card.label] ?? []) {
      const r = await clickInteractiveCard(ev, text, { timeoutMs: 2500 })
      if (r?.clicked) {
        submitted = r
        break
      }
    }
    if (!submitted) return { handled: clicks.length, clicks, stuck: card }
    clicks.push(submitted)
    await waitForCardGone(ev, { timeoutMs: 6000 })
  }
  return { handled: clicks.length, clicks, stuck: await detectCard(ev) }
}
