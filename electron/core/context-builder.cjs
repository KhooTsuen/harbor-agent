/** CE-003：统一 Context Builder。
 * 预算以字符估算，优先保留当前任务、状态和近期消息；超长工具结果截断。
 *
 * ⚠️ 2026-09-28 真机事故（用户报「DeepSeek 都支持多模态了，它还说看不见图」）：
 * 这里以前对每条消息一律 `JSON.stringify(content)` 再按字符切。带图消息的 content
 * 是**多模态数组** ——
 *   `[{type:'text',text:'这是什么'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBOR…'}}]`
 * 压成字符串再切，图片就只剩一段文件头。模型收到的是**坏图**，
 * 于是如实回答「画面数据没进来」。现在：**图片块整块保留，只切文本**。
 */
const { textOf, countImages } = require('./message-text.cjs')

const DEFAULT_BUDGET = {
  system: 10,
  memory: 5,
  project: 15,
  task: 10,
  conversation: 30,
  tools: 20,
  reserve: 10,
}

/**
 * 项目上下文的下限（字符）—— **不受上面的百分比管**。
 *
 * 2026-10-03 实测：Harbor 自己的 `AGENT.md` 是 8157 字符，`budget.project`（总字符
 * 的 15%）只给到 1843 —— 经过两道裁剪后只剩 1817 字符，15 个标题只进去 4 个，
 * 「硬禁区」「收工前必须跑」「交付时必须报告」和全部附录**模型从来没读到过**。
 * 这不是「省 token」，是「写在文件里的规矩默默失效」—— 用户以为已经交代过了。
 *
 * 为什么用下限而不是调大百分比：
 *   · 各层的额度是**各自独立算的**（memory / project / task / conversation 互不挤占，
 *     对话那条才是唯一按 remaining 递减的），所以这里放宽**不会**抢别层的额度；
 *   · 百分比会让「项目上下文」随对话预算缩水 —— 而它跟对话多长没关系：
 *     硬约束该不该被读到，不该取决于 `assistant.maxTokens` 填了多少。
 *
 * 上限仍然有，而且由**生产者**兜住（`project.cjs` + `project-rules.cjs` 各自带上限与
 * 「已截断」标记）—— 所以这里给的是「不裁」，不是「无限」。下限是**算出来的**：
 * 两个生产者的上限相加再加一点余量（头部标题与截断说明）。
 * 不写死数字：那三个数各自会变，写死就会漂——症状是「文件明明在上限以内，
 * 进上下文还是被切」，而且没有任何测试会报（改上限的人不会想到还有第二处数字）。
 */
const PROJECT_FLOOR =
  require('./project.cjs').MAX_CHARS + require('./project-rules.cjs').MAX_CHARS + 1024

/**
 * 一张图按多少字符占预算。
 *
 * **不能按 base64 的真实长度算**：一张 200KB 的图是 27 万字符，而 API 侧只按
 * 一千来个 token 计——照真长算的话，一张图就把整个对话预算挤没，消息全被丢掉。
 * 给个固定成本，保证「带图的那条」总排得进来，同时压住「一次塞五张图」的极端情况。
 */
const IMAGE_COST = 800

function chars(value) {
  return typeof value === 'string' ? value.length : 0
}
function trim(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 40))}\n[…上下文已按预算裁剪…]`
}
/** 切一条消息的内容：多模态**只切文本、图片整块留**（切一半的 base64 是坏图） */
function trimContent(content, limit) {
  if (!Array.isArray(content)) return trim(textOf(content), limit)
  const textLimit = Math.max(0, limit - countImages(content) * IMAGE_COST)
  return content
    .map((part) => {
      if (typeof part?.text !== 'string') return part
      /* 文本预算已被图片占满：整段丢掉。留半句话除了误导模型没别的作用 */
      if (textLimit <= 0) return null
      return { ...part, text: trim(part.text, textLimit) }
    })
    .filter((part) => part !== null)
}

/** 一条消息占多少预算：文本按字符，图片按固定成本 */
function sizeOf(content) {
  if (!Array.isArray(content)) return chars(content)
  return chars(textOf(content)) + countImages(content) * IMAGE_COST
}
function assemble(input = {}) {
  /*
   * ★ 这里的 `maxTokens` 是**上下文预算的基准**（字符 = token × 3），不是「输出上限」——
   *   虽然调用方传的就是设置里的 `assistant.maxTokens`（历史耦合，2026-09-29 没拆）。
   *   两件事混在一起的真实后果：用户把「输出上限」改大，上下文也会跟着变宽。
   *   0 = 不限（新的默认）→ 退回 4096，也就是和以前一样。
   */
  const maxTokens = Math.max(2000, Number(input.maxTokens) || 4096)
  const budget = { ...DEFAULT_BUDGET, ...(input.budget || {}) }
  const totalChars = maxTokens * 3
  const cap = (name) => Math.max(400, Math.floor(totalChars * (Number(budget[name] ?? 10) / 100)))
  const state = trim(input.conversationState, cap('task'))
  const memory = trim(input.memory, cap('memory'))
  /* 项目上下文：按百分比算完再抬到下限 —— 见 PROJECT_FLOOR 的注释（两道裁剪的实测） */
  const project = trim(input.project, Math.max(cap('project'), PROJECT_FLOOR))
  const task = trim(input.task, cap('task'))
  const recent = Array.isArray(input.messages) ? input.messages : []
  let remaining = cap('conversation')
  const selected = []
  for (let i = recent.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const item = recent[i]
    const copy = { ...item, content: trimContent(item.content, remaining) }
    const size = sizeOf(copy.content)
    if (size > 0) {
      selected.unshift(copy)
      remaining -= size
    }
  }
  return {
    systemContext: { memory, project, task, conversationState: state },
    messages: selected,
    estimates: { maxTokens, chars: totalChars - remaining, selectedMessages: selected.length },
  }
}
module.exports = { DEFAULT_BUDGET, PROJECT_FLOOR, assemble, trim }
