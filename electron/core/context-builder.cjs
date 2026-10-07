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

/**
 * 各层占上下文预算的百分比 —— **只列 `assemble` 真的会用的那些**。
 *
 * ★ 2026-10-08：这里以前有 7 个键（多出 `system` / `tools` / `reserve` 三个），
 *   但 `assemble` 从来没用过它们。实测：把 `budget.system` 改成 90，各层输出
 *   **逐字不变**（`memory 2457 / project 21024 / state 4936 / msgs 5`）—— 声明了却从不使用的
 *   预算是个陷阱：改它的人以为动了那一层的额度，实际什么也没发生，而且**不会有任何测试报红**。
 *   本项目的 `AGENT.md` 硬约束 8（会涨的数字不写死）讲的是同一个道理的另一面：
 *   **写在表里就得有人用**。所以现在只留四个真正生效的，并且加一条自检
 *   （`scripts/selftest/groups/116-project-context-complete.mjs` 的「表里每一项都真的生效」）——
 *   以后谁再加一个死键，自检当场变红。
 *
 * ⚠️ 想给某层加预算：**先让 `assemble` 真的用上它**，再回来加键。顺序反了就是又造一个陷阱。
 *
 * ⚠️ 这里删掉的键**不影响老配置** —— `assemble` 里是合并
 *   （`{ ...DEFAULT_BUDGET, ...(input.budget || {}) }`），老盘 `config.context.budget`
 *   里那三个键会被原样并进来，只是内核不再假装在管它们（见 `config-defaults.cjs` 的注释）。
 */
const DEFAULT_BUDGET = {
  /** 记忆（Relevant Memory）层 */
  memory: 5,
  /** 项目说明（AGENT.md / .harbor 规则）层 —— 实际额度还会抬到 `PROJECT_FLOOR` 下限 */
  project: 15,
  /** 会话状态（Conversation State）层。⚠️ 键名是历史遗留（仍叫 `task`）——
   *  改键名会动老配置，`assemble` 实参里也从来没有 `task` 这一项，别照着名字猜用途 */
  task: 10,
  /** 近期对话消息 */
  conversation: 30,
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
const PROJECT_FLOOR = require('./prompt-limits.cjs').PROJECT_FLOOR_CHARS

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

/**
 * 至少留这么多原文才值得把一条消息留下（见 assemble 里那个 `size < MIN_KEEP_CHARS`）。
 *
 * 2026-10-04：以前预算被挤到极限时，旧消息会被裁得**只剩一行裁剪说明**（14 字符）——
 * 它占着预算，却不提供任何信息，模型只能看到一串「上下文已按预算裁剪」。
 * 现在这种残片不要：宁可整条不进上下文（并把条数告诉模型，见 assemble 的 droppedNote）。
 */
const MIN_KEEP_CHARS = 200

/**
 * 裁剪说明的**固定长度**（算预算时要预先留出来）。
 *
 * 带上了原长：模型（和事后看日志的人）能区分「这条本来就很短」和「它有两万字但只进来了开头」。
 * 尾部的 `…上下文已按预算裁剪…` 刻意保留原措辞 —— 历史文档、自检组（86-vision）与
 * 用户回的会话记录里都是这个串，换掉它等于把过去的证据链断掉。
 */
const TRIM_NOTE_RESERVE = 64
const trimNote = (len) => `\n[这条消息原有 ${len} 字符，只有开头进得来。…上下文已按预算裁剪…]`

function trim(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  const note = trimNote(text.length)
  return `${text.slice(0, Math.max(0, limit - note.length))}${note}`
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
/**
 * `assistant.maxTokens = 0`（不限）时的上下文基准。
 *
 * 2026-10-04 真机实测：贴 96122 字符，模型只看到前 3646 字符（≈3.8%）—— 因为
 * 「不限」时基准退回 4096 → 总字符 12288 → 对话层 30% = **3686 字符**。
 * 这个 4096 是历史上「输出上限默认值」留下的，跟上下文窗口没关系：
 * 一线模型窗口早就 64k+ 了，没有任何理由把对话层压在 3.7k 字符。
 *
 * 改成 16384 之后：总字符 49152 → 对话层 30% = **14745 字符**（≈1.5 万），
 * 「几千到一两万字符的粘贴」能直接被看到；同时仍然**留着一个防呆上限**
 * （不是无限：这一层的上限就是 14745 字符 ≈ 4.9k token）。
 *
 * 只影响「0 / 没填」的情况：用户显式填了值（含任务级覆盖）一律照旧 —— 所以
 * 这个数字不会覆盖任何人的显式设置，也不会改变「输出上限」的语义。
 *
 * ★ 渲染层 `src/constants/index.ts` 的 `CONTEXT_BASE_TOKENS` 必须与它同一个值
 * （跨进程没法共享常量）；`contextBaseDrift.test.ts` 盯着两边。
 */
const DEFAULT_CONTEXT_TOKENS = 16384

function assemble(input = {}) {
  /*
   * ★ 这里的 `maxTokens` 是**上下文预算的基准**（字符 = token × 3），不是「输出上限」——
   *   2026-10-04 起调用方（`loop-prompt.cjs`）传的是 `config.context.baseTokens`，
   *   不再传设置里的 `assistant.maxTokens`（那个是输出上限，历史耦合已拆）。
   *   两件事混在一起的真实后果：用户把「输出上限」改大，上下文也会跟着变宽。
   *   0 = 不限 → 用 DEFAULT_CONTEXT_TOKENS（见上面的来由）；
   *   显式填了值就听用户的（测试也靠这条构造小预算）。
   */
  const maxTokens = Math.max(2000, Number(input.maxTokens) || DEFAULT_CONTEXT_TOKENS)
  /*
   * 合并顺序 = 「表里的默认」打底、「传进来的配置」覆盖。
   * 老盘的 `config.context.budget` 里可能还有 `system` / `tools` / `reserve`
   * （见 DEFAULT_BUDGET 的注释）—— 它们会被原样并进这个对象，但下面没有任何地方读它们。
   */
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
  let dropped = 0
  let i = recent.length - 1
  for (; i >= 0 && remaining > 0; i -= 1) {
    const item = recent[i]
    const original = sizeOf(item.content)
    const copy = { ...item, content: trimContent(item.content, remaining) }
    const size = sizeOf(copy.content)
    /*
     * 「被裁到只剩一行说明」的残片不要（见 MIN_KEEP_CHARS 的注释）。
     * 判据是「被缩过 且 剩得很小」—— 本来就很短的消息（「你好」）不受影响。
     * 不扣预算：留不出像样内容的残片不值得占位，宁可让更早的消息也因此整条不进。
     */
    if (size > 0 && size < MIN_KEEP_CHARS && size < original) {
      dropped += 1
      continue
    }
    if (size > 0) {
      selected.unshift(copy)
      remaining -= size
    }
  }
  /* 预算用完时，更早的那些**根本没轮到** —— 它们同样是「没进上下文」，要一起算上 */
  if (i + 1 > 0) dropped += i + 1
  /*
   * 有消息被整条丢掉时，**一处**说明比 N 行残片有用：模型因此知道「上面还有内容」，
   * 却又不用为每个被丢的旧消息付一行预算。挂在会话状态那一层（系统侧）。
   */
  const droppedNote = dropped > 0 ? `\n（更早的 ${dropped} 条对话因预算没进上下文）` : ''
  return {
    systemContext: { memory, project, task, conversationState: state + droppedNote },
    messages: selected,
    estimates: {
      maxTokens,
      chars: totalChars - remaining,
      selectedMessages: selected.length,
      droppedMessages: dropped,
    },
  }
}
module.exports = {
  DEFAULT_BUDGET,
  DEFAULT_CONTEXT_TOKENS,
  MIN_KEEP_CHARS,
  PROJECT_FLOOR,
  TRIM_NOTE_RESERVE,
  assemble,
  trim,
}
