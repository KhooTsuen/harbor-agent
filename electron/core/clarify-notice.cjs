/**
 * 澄清卡超时后的**通知文案**（AG-053 批③）
 *
 * 为什么要单独一个文件：这段话同时要满足两条互相拉扯的要求 ——
 *   · 用户可能是在**离开之后**回来看到这条通知的，所以第一句必须说清「发生了什么」
 *     （没等到你 → 我按默认继续了），而不是「澄清超时」这种内部词；
 *   · 他还要能一眼认出**是哪条任务**、以及**替他把哪个选项定了** ——
 *     「你回来一看文件被改了」是最难受的体验。
 *
 * 纯函数、不碰 Electron、不碰 IO：文案能单独断言（自检 102 组），
 * 而「什么时候发」（主进程 sweep）与「怎么发」（handlers/notify.cjs）都在外面。
 */

/** 一个默认选项最多显示多少字（通知正文只塞得下这么多） */
const MAX_ADOPTED_CHARS = 120
/** 正文总长上限（和 notify.cjs 的 MAX_BODY 一致） */
const MAX_BODY_CHARS = 400

const clip = (value, max) => {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * 「替他定了什么」——把每条问题的默认选项串起来。
 *
 * 例：`一行 install.sh；加`
 *
 * @param {Array<{question?: string, defaultValue?: string}>} questions `clarify.normalize()` 的输出
 */
function adoptedText(questions) {
  const list = Array.isArray(questions) ? questions : []
  const picked = list.map((one) => String(one?.defaultValue ?? '').trim()).filter(Boolean)
  return clip(picked.join('；'), MAX_ADOPTED_CHARS)
}

/**
 * 超时通知的标题与正文。
 *
 * @param {{ taskTitle?: string, questions?: unknown[] }} input
 * @returns {{ title: string, body: string }}
 */
function timeoutNotice({ taskTitle = '', questions = [] } = {}) {
  const who = clip(taskTitle, 60) || '这条任务'
  const adopted = adoptedText(questions)
  const body = [
    `没等到你的回答，已经按默认选项继续：${adopted || '（没有可用选项）'}`,
    '回来可以打开这条对话看它具体做了什么，不满意就撤销（右栏「审查」里有改动记录）。',
  ].join('\n')
  return {
    /* 标题里带任务名：通知只显示一行时，用户先看到「哪条」再决定要不要点 */
    title: clip(`澄清超时：${who} 已按默认继续`, 120),
    body: clip(body, MAX_BODY_CHARS),
  }
}

module.exports = { adoptedText, timeoutNotice, MAX_ADOPTED_CHARS }
