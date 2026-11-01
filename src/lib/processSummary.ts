import type { ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   过程区入口的文案（纯逻辑，不碰 React）

   ── 为什么单独一个文件 ────────────────────────────────────────
   它同时被**三个**地方用，而三处必须说同一句话：
     · `components/chat/ProcessPanel.tsx`（界面上的折叠入口）
     · `lib/export.ts`（导出 .md 的 `<summary>`）
     · `lib/export.ts` 的「复制完整记录」
   各写一份的话，导出的文件会说「2 个步骤」而界面说「含 1 项失败」——
   同一份数据两个说法，用户没法判断哪个是真的。

   放在 `lib/` 而不是组件里还有一个原因：`lib` 不该反向依赖 `components`
   （导出是纯数据逻辑，不该为了拼一句话去拉一个 React 组件树）。

   ── 四档口径（2026-10-21 用户第三次拍板 + 图2 验收表）──────────
     · **运行中** → 恒为「实时任务」，**不报任何计数**。
       以前这里拼 `${runs.length} 个步骤`：每调一次工具入口就变一次字，
       整行入口跟着跳，用户的原话是「不要实时统计」。
       步骤数要等执行结束**一次性**算出来。
     · **中断** → 「已中断」（没有用时可言，也不混进完成态）
     · **任务没成**（整轮报错 / 每一步都失败）→ 「失败 · N 个步骤」
     · **任务成了、但中间失手过** → 「N 个步骤 · 含 M 项失败」
       ★ 这一档是图2 验收表第二行点名要的：一次操作失败 ≠ 整个任务失败。
         写成「失败」会让用户以为这条回答没出来，而其实答案就在下面。
       用时不再进入口 —— 它挪到展开区第一行（见 ProcessPanel），
       入口严格只回答「收的是什么东西、什么状态」。
   ══════════════════════════════════════════════════════════════ */

/** 运行中入口的固定文案 —— 界面与测试共用这一份，别各写各的 */
export const PROCESS_RUNNING_LABEL = '实时任务'

/** 毫秒 → 人读的用时（31 秒 / 6 分 12 秒）。不引日期库，也不显示毫秒。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const min = Math.floor(total / 60)
  const sec = total % 60
  return sec > 0 ? `${min} 分 ${sec} 秒` : `${min} 分`
}

/** 入口要读的几个字段（只声明用得到的，测试不必造一条完整消息） */
export interface ProcessHeaderInput {
  durationMs?: number
  interrupted?: boolean
  /** 还在跑（`streaming`）—— 入口只写「实时任务」 */
  running?: boolean
  /** 这条消息最终失败了（`status === 'error'`）；工具级的失败另有判据 */
  failed?: boolean
}

/**
 * 失败了几条「已经跑完」的工具。
 *
 * ★ `ms === undefined` 的不算：那只是**还在跑**（`tool.started` 先插了空记录），
 *   把在跑的算成失败会让入口在跑的过程中变红。
 */
export function failedRunCount(runs: readonly ToolRunRecord[]): number {
  return runs.filter((run) => !run.ok && run.ms !== undefined).length
}

/** 入口要说的完整状态（界面拿它决定文案 / 要不要红叉） */
export interface ProcessEntry {
  /** 入口那一行字 */
  text: string
  /** 整轮没成 —— 只有这一种情况入口给红叉 */
  taskFailed: boolean
  /** 单项失败（任务照样完成）—— 文案里已经写了「含 N 项失败」 */
  partialFailures: number
  running: boolean
  interrupted: boolean
}

/**
 * 入口状态 —— 界面与导出**共用这一份**判断，别在 JSX 里再算一遍。
 *
 * ★ 运行中**先返回**：下面所有计数（步骤数 / 失败数）在跑的过程中都会变，
 *   拼进入口就是「入口自己跳字」。用户明确要的是「实时任务」四个字恒定。
 */
export function processEntry(
  message: ProcessHeaderInput,
  runs: readonly ToolRunRecord[],
): ProcessEntry {
  if (message.running) {
    return {
      text: PROCESS_RUNNING_LABEL,
      taskFailed: false,
      partialFailures: 0,
      running: true,
      interrupted: false,
    }
  }
  if (message.interrupted) {
    return {
      text: '已中断',
      taskFailed: false,
      partialFailures: 0,
      running: false,
      interrupted: true,
    }
  }

  const failedRuns = failedRunCount(runs)
  /*
   * 「任务失败」与「这几步里有一项失败」是两件事（图2 验收表第二 / 三行）：
   *   · 整轮报错（`status === 'error'`）或**每一步都失败** → 任务没成
   *   · 中间失手一次、后来重试成功、回答正常 → 任务成了，只是有单项失败
   */
  const taskFailed = message.failed === true || (runs.length > 0 && failedRuns === runs.length)
  const parts: string[] = []
  if (taskFailed) parts.push('失败')
  if (runs.length > 0) parts.push(`${runs.length} 个步骤`)
  if (!taskFailed && failedRuns > 0) parts.push(`含 ${failedRuns} 项失败`)

  /*
   * 一个都没有时给一句兜底 —— 调用方已经保证「没过程不挂入口」，
   * 但这里不该返回空串让人在界面上看到一行空白按钮。
   */
  return {
    text: parts.length > 0 ? parts.join(' · ') : '查看过程',
    taskFailed,
    partialFailures: taskFailed ? 0 : failedRuns,
    running: false,
    interrupted: false,
  }
}

/** 只要那一行字（测试 / 导出用；判断状态请用 `processEntry`） */
export function processHeaderText(
  message: ProcessHeaderInput,
  runs: readonly ToolRunRecord[],
): string {
  return processEntry(message, runs).text
}
