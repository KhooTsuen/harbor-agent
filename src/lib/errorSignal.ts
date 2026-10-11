import type { ErrorEntry, ErrorSeverity } from '@/types/errors'

/* ══════════════════════════════════════════════════════════════
   错误「未读」信号（Phase 1 · A1）

   右栏「错误」标签原来**没有任何角标** —— 内核在出错现场记了严重错误，
   用户不看那个标签就完全不知道。这里提供一处**纯函数**的判据，角标与
   面板共用：

     · 「严重」 = P0（用不了）/ P1（严重）。P2/P3 属于「不是故障」，不点亮角标。
     · 「未读」 = **lastSeen 晚于上次已读时间**的错误。这是「自你上次看之后
       新出现的」，**不是**「还没解决」—— 面板里的错误一律保持原样列出，
       打开面板只把「未读」清零，绝不声称问题已处理（那会变成误导）。

   为什么单独一个纯函数文件：角标在 RightPanel/AppTitleBar，面板在
   ErrorsPanel —— 三处不能各写一套判据（跨模块约定只有一处真相源）。
   ══════════════════════════════════════════════════════════════ */

/** 「需要立刻知道」的两级严重性。要加一级就改这里（另两处都读它） */
export const SEVERE_SEVERITIES: readonly ErrorSeverity[] = ['P0', 'P1']

/** 严重性排序用的权重（数越大越严重） */
const RANK: Record<ErrorSeverity, number> = { P0: 3, P1: 2, P2: 1, P3: 0 }

/**
 * 时间戳归一成毫秒数。
 *
 * ★ 这里**接受两种形状**：数字原样用，字符串按 ISO 解析。
 *
 *   来历（**Phase 3 实测更正**）：Phase 1 曾据「真机数据里 `lastSeen` 是 ISO
 *   字符串」加了这层兼容，并断言内核 `error-reader.cjs` 把记录的 `ts` 原样透传。
 *   **实际不是** —— `error-reader.cjs` 的 `parseLine` 里 `ts = Date.parse(...)`，
 *   输出**一直是毫秒数**。Phase 3 用 `tmp/p3-m2probe.cjs` 实测确认：
 *   `read({dir})` 返回的 `firstSeen/lastSeen` 都是 `number`。当时看到的那串 ISO
 *   是 `data/errors/*.jsonl` **磁盘原始记录**里的 `ts`，不是 reader 的输出。
 *
 *   所以这层兼容是**防御性**的（旧数据 / 别的来源），不是修 bug；
 *   类型声明 `number` 本身是对的，不用改。
 */
function epochOf(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = Date.parse(String(value ?? ''))
  return Number.isNaN(parsed) ? 0 : parsed
}

/** 是不是「严重」那一档（P0/P1） */
export function isSevere(severity: ErrorSeverity): boolean {
  return severity === 'P0' || severity === 'P1'
}

/**
 * 自 `since` 之后**新出现**的严重错误条数。
 *
 * 按「最后出现时间」判 —— 一条老错误又发生了一次（lastSeen 变新），
 * 也算「新动静」，用户该再看一眼。
 */
export function countUnreadSevere(entries: readonly ErrorEntry[], since: number): number {
  let n = 0
  for (const entry of entries) {
    if (isSevere(entry.severity) && epochOf(entry.lastSeen) > since) n += 1
  }
  return n
}

/**
 * 未读严重错误里**最严重**的那一级；没有就返回 null。
 * 角标据此选颜色（P0 用失败色、P1 用警告色）—— 颜色仍走 statusLanguage。
 */
export function worstUnreadSeverity(
  entries: readonly ErrorEntry[],
  since: number,
): ErrorSeverity | null {
  let worst: ErrorSeverity | null = null
  for (const entry of entries) {
    if (!isSevere(entry.severity) || epochOf(entry.lastSeen) <= since) continue
    if (!worst || RANK[entry.severity] > RANK[worst]) worst = entry.severity
  }
  return worst
}
