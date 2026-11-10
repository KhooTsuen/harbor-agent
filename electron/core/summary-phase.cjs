/**
 * 总结阶段：独立的模型对话
 *
 * ── 为什么要拆（2026-11-08）────────────────────────────────────
 *
 * 以前「干完活的那段汇报」就是工作 Agent Loop 最后一轮模型的输出。后果是：
 *   · 想让它「接着说」就得把**整份工作历史**再发一遍（几十条消息、几万 token）
 *   · 汇报的措辞由**正在干活的那个上下文**决定 —— 它容易把「我打算做」说成「已经做了」
 *   · 总结被截断时，续写发生在工作上下文里，模型有工具，理论上还能再动手
 *
 * 现在分成两个对话：
 *   工作阶段 —— 原样不动（工具、审批、台账、检查点全在那条路上）
 *   总结阶段 —— 只有两条消息（system + 交接材料），**没有工具**，只负责汇报
 *
 * ── 工具隔离是结构性的，不是靠提醒 ──────────────────────────────
 *
 * 两道闸，任一失效另一道还挡着：
 *   ① 请求体 `tools: []` —— 模型产不出合法的工具调用
 *   ② 这里**根本不接** `executeToolCalls`：就算上游硬返回 `tool_calls`，
 *      也一律当没看见，只取 `content`（见 `pickText`）
 *
 * 所以「续写不会重跑已完成的 Shell / 改文件 / 提交」不是承诺，是走不到那条路。
 *
 * ── 什么时候不启动 ────────────────────────────────────────────
 *
 * `wantSummary()` 判据：这一轮**真的执行过工具**（`toolRuns.length > 0`）。
 * 普通聊天、简单问答不执行工具 → 完全走原路，**一次额外请求都不发**。
 *
 * ★ 注意这条判据只回答「要不要开总结」，不回答「任务做完了没」——
 *   后者看收尾门禁与任务台账（见 `summary-handoff.verdictOf`）。
 */

const replyContinue = require('./reply-continue.cjs')

/** 总结专用系统提示。**不给工具、不许动手、只按证据说** */
const SUMMARY_SYSTEM = `你是 Harbor 的汇报阶段。工作已经结束，你只负责把结果如实讲给用户。

铁规矩：
1. **你没有工具，也没有任何执行能力。** 不要调用工具，不要提议「我这就去改」，不要假装还能动手。
2. 只根据下面提供的执行记录汇报。记录说没做成的，不许说成做成了。
3. 失败项、没做完的事项**必须写出来**，不能只报喜。
4. 用简体中文，先给结论（做成了 / 部分做成 / 没做成），再说关键改动与证据。
5. 不要复述工具调用流水账，用户要的是「结果和影响」。
6. 篇幅按事情大小来，别为了显得完整而注水。`

/**
 * 要不要开总结对话。
 *
 * 只认「真执行过工具」—— 纯聊天不该为此多花一次请求。
 * @param {{ toolRuns?: Array<object> }} input
 */
function wantSummary({ toolRuns } = {}) {
  return Array.isArray(toolRuns) && toolRuns.length > 0
}

/**
 * 只取正文：**故意不看 toolCalls**。
 *
 * 上游万一返回了工具调用（提示词拦不住的概率不为零），这里也是唯一出口 ——
 * 它不会被交给执行层，只当它不存在。
 */
function pickText(result) {
  return String(result?.content ?? '')
}

/**
 * 跑一次总结对话。
 *
 * @param {{ handoff: { text: string, verdict: string },
 *           baseArgs: object, callModel: Function, emit?: Function }} input
 *   `baseArgs` 是主对话那一套（config / provider / model / signal / trace / task），
 *   这里只在它上面盖 `messages` 与 `tools`。
 * @returns {Promise<{ text: string, truncated: string, usage: object|null, continued: number }>}
 *   `truncated`：'' = 完整；`length` / `stream_cut` = 没写完（续写也没救回来时）
 */
async function runSummary({ handoff, baseArgs, callModel, emit }) {
  const messages = [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: String(handoff?.text ?? '') },
  ]

  /* ★ 打上用途：用量账本据此把「总结」和「干活」分开记（`purpose` 一路带到 logAttempt） */
  const args = { ...baseArgs, purpose: 'summary', maxRetries: 0 }

  const result = await callModel({
    ...args,
    messages,
    /* ① 第一道闸：结构上给不出工具 */
    tools: [],
    /* 总结不是主回答，别把逐字流推到主气泡上；整段回来再由下面发一次 */
    onContent: undefined,
    onReasoning: undefined,
  })

  let usage = result?.usage ?? null
  const addUsage = (u) => {
    if (u) usage = u
  }

  /*
   * 截断与续写复用 `reply-continue`：它的 `messages` 是外部传进来的，
   * 所以续写用的就是**总结这两条**，永远回不到工作上下文。
   * 顺带：它续写时也把 `tools` 传成空，第二道闸在那条路上同样成立。
   */
  const reply = await replyContinue.completeReply({
    result: { ...result, content: pickText(result) },
    messages,
    emit: (event) => {
      if (event.type !== 'content') emit?.(event)
    },
    callModel,
    addUsage,
    baseArgs: args,
  })

  const text = String(reply?.text ?? '')
  if (text.trim()) emit?.({ type: 'content', text, stage: 'answer' })

  return {
    text,
    truncated: reply?.cut ? String(reply?.reason ?? 'stream_cut') : '',
    usage,
    continued: Number(reply?.continued) || 0,
  }
}

module.exports = { runSummary, wantSummary, pickText, SUMMARY_SYSTEM }
