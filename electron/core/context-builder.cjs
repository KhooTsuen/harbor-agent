/** CE-003：统一 Context Builder。
 * 预算以字符估算，优先保留当前任务、状态和近期消息；超长工具结果截断。
 *
 * ── 2026-11-07（P1-A）：选取改成**按消息组** ────────────────────
 *
 * 这里曾经是一条一条从尾部往前取，于是「取到一串孤立 tool」时会把整份历史清零
 * （真实会话实测 863 条 → 0 条），「assistant 只调工具不说话」时更隐蔽
 * （62 条 → 2 条 / 13 字符）。选取逻辑现在住在 `context-groups.cjs`，
 * 那边解释了两种残缺的成因与本文件的规则。
 *
 * 本文件只剩三件事：**各层额度怎么算、系统层怎么拼、把结果整理成可诊断的形状**。
 * 文本口径（一条占多少预算、怎么按额度切）在 `context-text.cjs` —— 别在这里再写一份。
 */
const { trim, trimContent, sizeOfMessage, trimMessage } = require('./context-text.cjs')
const { selectMessages, MIN_KEEP_CHARS } = require('./context-groups.cjs')

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

/**
 * 字符当量 → token 的**粗估**。系数的唯一出处是 `compact-chunked.cjs`（同一个公式不写两遍）。
 * ⚠️ 这是估算：中文约 1.5 字/token、英文约 4 字符/token，混算取 chars/3 偏保守。
 * **不是** API 计费 token（那只有供应商返回的 usage 才是）。
 */
function estimateTokensOf(chars) {
  return Math.ceil((Number(chars) || 0) / 3)
}

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

  /* 对话层：按**消息组**从尾部往前挑（规则见 context-groups.cjs 的文件头） */
  const selected = selectMessages(recent, cap('conversation'), { sizeOfMessage, trimMessage })
  const dropped = selected.dropped

  /*
   * 有消息被整条丢掉时，**一处**说明比 N 行残片有用：模型因此知道「上面还有内容」，
   * 却又不用为每个被丢的旧消息付一行预算。挂在会话状态那一层（系统侧）。
   * 两种原因分开说：预算不够 / 记录本身不完整（后者不该被当成「被裁了」）。
   */
  const budgetDropped = Math.max(0, dropped - selected.invalid)
  const droppedNote = budgetDropped > 0 ? `\n（更早的 ${budgetDropped} 条对话因预算没进上下文）` : ''
  const incompleteNote =
    selected.invalid > 0 ? `\n（${selected.invalid} 条工具调用记录不完整，已从本轮上下文排除）` : ''
  const systemContext = {
    memory,
    project,
    /* 历史遗留字段：`prompt-stack` 不读它，但返回形状保持原样（别处可能取） */
    task,
    conversationState: state + droppedNote + incompleteNote,
  }
  /*
   * 口径（P1-B）：这里给出的是**这一轮真正拼进请求的那份东西**，不是磁盘上的历史总量。
   * 四项分开写，别合成一个「用量」——
   *   · `conversation.chars`  对话层实际发出去的字符当量（含工具调用与结果的真实占比）
   *   · `system.chars`        各系统层拼完之后的字符数
   *   · `input.chars/tokens`  **整份模型输入**的估算（系统各层 + 对话层）
   *   · `budget`              这一层的额度与分母（谁给的、给了多少）
   * 全部是**字符换算的估算**，不是 API 计费 token（那个只有供应商返回的 usage 才是）。
   */
  const systemChars =
    systemContext.memory.length +
    systemContext.project.length +
    systemContext.task.length +
    systemContext.conversationState.length
  const inputChars = systemChars + selected.chars
  return {
    systemContext,
    messages: selected.messages,
    estimates: {
      maxTokens,
      /** 整份模型输入的字符当量（系统各层 + 对话层） */
      chars: inputChars,
      /** 字符当量换算的 token 估算（**估算**，见 estimateTokensOf） */
      tokens: estimateTokensOf(inputChars),
      systemChars,
      conversationChars: selected.chars,
      /** 对话层额度（字符）与还剩多少 —— 用来判断「是不是预算不够」 */
      conversationBudget: cap('conversation'),
      conversationRemaining: selected.remaining,
      selectedMessages: selected.messages.length,
      droppedMessages: dropped,
      /** 其中因为工具协议不完整被排除的 */
      invalidMessages: selected.invalid,
    },
  }
}

module.exports = {
  DEFAULT_BUDGET,
  DEFAULT_CONTEXT_TOKENS,
  MIN_KEEP_CHARS,
  PROJECT_FLOOR,
  TRIM_NOTE_RESERVE: require('./context-text.cjs').TRIM_NOTE_RESERVE,
  assemble,
  estimateTokensOf,
  /* 文本口径的老出口（自检组与测试按它比）—— 实现只有一处：context-text.cjs */
  trim,
  trimContent,
}
