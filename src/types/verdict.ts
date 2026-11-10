/* ══════════════════════════════════════════════════════════════
   一次执行的**验收结论**（2026-11-09）

   ── 为什么它和答复正文是两件事 ────────────────────────────────
   正文是「模型说了什么」，结论是「按台账证据看，做成了没有」。
   两者经常不一致，而且不一致的时候才是用户最需要知道的：
   正文写着「都处理好了」，台账里却还有失败项 —— 这时界面必须能说出来，
   而不是让用户读措辞去猜。

   ── 谁算的 ────────────────────────────────────────────────────
   内核 `electron/core/summary-handoff.cjs` 的 `verdictOf()`，
   按**结构化证据**判：失败项 / 未完成计划 / 测试退出码。不是从文字里读语气。

   ── 四个取值 ──────────────────────────────────────────────────
     `done`    按计划做完，没有失败项
     `partial` 部分完成（有失败项或没做完的事项）
     `failed`  没做成
     `chat`    纯聊天，根本没执行工具 —— 没有「验收」这回事

   ★ 老记录没有这个字段 → 界面不显示这一行，**不猜成 done**。
   ══════════════════════════════════════════════════════════════ */

export const EXEC_VERDICTS = ['done', 'partial', 'failed', 'chat', ''] as const

export type ExecVerdict = (typeof EXEC_VERDICTS)[number]

/** 这个结论要不要在界面上说出来（`chat` / 空值都不说 —— 聊天没有验收） */
export function showsVerdict(verdict: ExecVerdict | undefined): boolean {
  return verdict === 'done' || verdict === 'partial' || verdict === 'failed'
}

/** 结论 → 一句人话（界面与导出共用；空值返回空串） */
export const VERDICT_TEXT: Record<string, string> = {
  done: '按计划完成',
  partial: '部分完成 —— 有失败项或未做完的事项',
  failed: '没有完成 —— 见过程里的错误',
}
