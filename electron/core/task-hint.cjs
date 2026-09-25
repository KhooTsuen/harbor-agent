/*
 * 「任务 / 计划」这件事怎么讲给模型听。
 *
 * 单独一个文件，两个原因：
 *   ① 同一套说法要用在**两处**（有未完成任务时的台账、新活的第一轮），
 *      各写一遍迟早对不上；
 *   ② `task-context.cjs` 已经贴到 300 行上限了。
 *
 * ── 真机实测的教训（deepseek-flash，2026-09-19）──
 *   只把「多步的活先给 ```plan 块」写进系统提示的通用条目里，**模型不理** ——
 *   给了一句明显多步的请求（读两个文件、对比、给建议），它一个计划块都没写，
 *   任务于是没有计划、名字只能从聊天句截。
 *   带着**这次用户那句话**一起说，它才照做（同一句话+台账时实测会写）。
 *   所以新活的第一轮必须注入 `freshRequest()`，不能只靠通用规矩。
 */

/** 计划块的格式说明 —— 两处共用同一份措辞，改一次两边都变 */
const PLAN_FORMAT =
  '**先给一个 ```plan 块**：第一行写任务名（形如 `# 优化启动速度`，一句话说清在做什么），' +
  '下面每行一条步骤。做完一步就把那条标成 `[x]`，再重发一遍**完整**计划。'

/**
 * 一条未完成任务都没有时的注入内容（= 新活的第一轮）。
 *
 * 不注入的话模型不知道「这活要立任务、要给名字」—— 这是 AG-027
 * 「任务有自己的名字」在真实对话里唯一能生效的入口。
 *
 * 带上了用户原话，所以这段是**每轮都可能变**的：它会进提示的易变区
 * （prompt-stack 里 taskState 层本来就在易变区）。
 */
function freshRequest(goal) {
  const text = String(goal ?? '').trim()
  if (!text) return ''
  return [
    '## 本轮请求（还没立任务）',
    `用户这句话：「${text.slice(0, 200)}」`,
    `这活要读好几个文件 / 改好几处 / 跑好几轮才做得完，就${PLAN_FORMAT}`,
    '界面上那条任务横幅照这个块显示名字和进度。一两句就能答完的事不要写计划块。',
  ].join('\n')
}

/** 台账里那句「怎么更新计划」—— 和 freshRequest 用同一份格式说明 */
function ledgerFormatLine() {
  return `做完一步就把那一条标成 \`[x]\`：${PLAN_FORMAT}任务名只在第一次生效，之后保持稳定。`
}

/**
 * taskState 是不是「新活第一轮」那段（而不是带计划的台账）？
 *
 * ★ TOK-P2-004（真机电池实测）：别用「taskState 非空」当「有任务在跑」——
 *   `chat.cjs` 的 buildTaskState 在**一条未完成任务都没有**时也会兜底返回
 *   `freshRequest()`（那是「这活要立任务」的必要注入）。于是
 *   「非空 ⇒ 跳过模板建议」的条件在真机上**永远成立**，
 *   模板层一次都没送出去过（电池 30 个任务、0 命中）。
 *
 * 调用两边的「用户那句话」修剪口径可能不同（chat.cjs 的 lastUserText
 * 会先 `slice(0,200)`），所以原样与 slice(0,200) 两种都认。
 */
function isFreshTaskState(taskState, goal) {
  const t = String(taskState ?? '').trim()
  if (!t) return true
  /*
   * 两个候选都按**原样**算：chat 侧是「先 slice(0,200) 再进 freshRequest」，
   * 我们手里是完整原话 —— 前后空格会把两种修剪顺序切出不同的前 200 字符，
   * 所以 raw 与 raw.slice(0,200) 各试一次（freshRequest 内部还会 trim）。
   */
  const raw = String(goal ?? '')
  return t === freshRequest(raw).trim() || t === freshRequest(raw.slice(0, 200)).trim()
}

module.exports = { PLAN_FORMAT, freshRequest, ledgerFormatLine, isFreshTaskState }
