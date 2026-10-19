import type { TaskEndPayload, TaskOutcome } from '@/types/notify'

/* ══════════════════════════════════════════════════════════════
   任务结果摘要（P2 #30）

   把「这一轮到底成了没成」说清楚：完成 / 失败 / 到上限，改了哪些东西，
   检查跑没跑、过没过。

   ── 三条硬规矩（文档验收）────────────────────────────────────
     ① **不把未运行的检查写成通过** —— `tests: 'unknown'`（跑过但读不出结果）
        和 `'none'`（没跑）都要单独说，不能并进「通过」。
     ② **不把取消写成完成** —— 用户自己按停止的那一轮，内核根本不会推
        taskEnd（见 `task-notify.cjs` 的 END_META），所以这里也不会出现；
        而撞预算 / 转圈停下是 `warning`，措辞是「已停下」，不是「完成」。
     ③ **判据来自任务台账**（内核 `task-outcome.cjs`），不是模型自述。

   这是纯函数：组件只负责画，判据单独能测。
   ══════════════════════════════════════════════════════════════ */

export type SummaryTone = 'success' | 'failed' | 'stopped'

export interface TaskSummaryView {
  tone: SummaryTone
  /** 一句话结论（不含任务名，任务名由组件另起一行） */
  headline: string
  /** 逐条事实：改动、检查、以及「为什么停下」 */
  facts: string[]
  /** 检查的结论，单独一项 —— 界面上要能一眼看出「没跑」还是「没过」 */
  testLabel: string
  /** 有没有值得点进去看的东西 */
  hasFiles: boolean
}

/** 检查状态 → 人话。★ 四态各说各的，绝不合并。 */
export function testLabelOf(tests: TaskOutcome['tests']): string {
  if (tests === 'passed') return '检查通过'
  if (tests === 'failed') return '检查失败'
  if (tests === 'unknown') return '检查跑过，但读不出结果'
  return '检查未运行'
}

export function taskSummaryOf(payload: TaskEndPayload): TaskSummaryView {
  const outcome = payload.outcome
  const tone: SummaryTone =
    payload.kind === 'success' ? 'success' : payload.kind === 'error' ? 'failed' : 'stopped'

  const headline =
    tone === 'success' ? '这一轮已完成' : tone === 'failed' ? '这一轮失败了' : '这一轮已停下'

  const facts: string[] = []
  facts.push(outcome.files > 0 ? `改动 ${outcome.files} 个文件` : '没有改动文件')

  /*
   * `payload.description` 是内核按台账写的明细（含「为什么停下」：撞预算 / 转圈）。
   * 它已经带了任务名，这里只取非空行里除任务名之外的补充信息 —— 不重写一遍。
   */
  const extra = String(payload.description ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('「'))
  for (const line of extra) facts.push(line)

  return {
    tone,
    headline,
    facts,
    testLabel: testLabelOf(outcome.tests),
    hasFiles: outcome.files > 0,
  }
}
