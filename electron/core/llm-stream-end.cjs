/*
 * 只取证（第一步）：上游流「没有结束标记就断了」怎么记一笔 —— **不改任何行为**。
 *
 * 背景：长流式生成有时会「写到一半没了」。三条已知的出错路径（空闲看门狗 /
 * 流里带 error / 内容全空）都会抛错；但**上游平静地把流结束掉**时，`chatStream`
 * 会当正常收尾返回 —— 界面当成「答完了」收下，日志里一行都没有，事后查不出来。
 *
 * 这个模块只做两件事：
 *   ① 判：有内容回来、但没有 `finish_reason` → 记一条 WARN（带字数与用时，便于对日志）
 *   ② 量：`HARBOR_LLM_TRACE=1` 时把**每一次**调用是怎么结束的都记一行 INFO
 *      —— 用来回答「这家上游正常答完时到底带不带 finish_reason」。
 *      如果不带，那判据 ① 会次次误报，得换信号（[DONE] / 字节增长 / 空闲时长）。
 *
 * 用完这一步拿到结论再决定要不要接提示或自动续写；现在返回的布尔没人消费。
 */
const log = require('./log.cjs')

/** 有东西回来了，却没有 `finish_reason` → 判为「断在半路」 */
function looksCutOff(info) {
  const got = Number(info?.content ?? 0) + Number(info?.reasoning ?? 0) + Number(info?.toolCalls ?? 0)
  return !info?.finishReason && got > 0
}

/**
 * 记一笔；返回是否判为「断在半路」。
 * @param {{ label?: string, model?: string, providerId?: string, finishReason?: string|null,
 *   content?: number, reasoning?: number, toolCalls?: number, ms?: number }} info
 */
function noteStreamEnd(info) {
  const where = `${info?.label ?? '对话'} · ${info?.model ?? '?'}${info?.providerId ? ` @ ${info.providerId}` : ''}`
  const cut = looksCutOff(info)
  if (cut) {
    log.warn(
      `上游流没有结束标记就断了（${where}）：没收到 finish_reason，但已经回来了 ` +
        `正文 ${info.content} 字 / 思考 ${info.reasoning} 字 / 工具调用 ${info.toolCalls} 个，用时 ${info.ms} ms`,
    )
  }
  if (process.env.HARBOR_LLM_TRACE) {
    log.info(
      `[llm-trace] ${where}：finish=${info?.finishReason ?? '(无)'} 正文=${info?.content ?? 0} ` +
        `思考=${info?.reasoning ?? 0} 工具=${info?.toolCalls ?? 0} 用时=${info?.ms ?? 0}ms${cut ? ' ← 断在半路' : ''}`,
    )
  }
  return cut
}

module.exports = { looksCutOff, noteStreamEnd }
