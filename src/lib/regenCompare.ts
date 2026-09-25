import type { StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   「对比两次生成」的纯函数（界面在 components/chat/message/RegenCompare.tsx）

   同一次提问重新生成过 → 有两个回答版本，用户想知道「这次和上次差在哪」：
     · 最终输出差异：逐行 diff（加行 / 删行）
     · 工具调用序列：两边各跑了什么、成功与否
     · 文件改动：从工具记录里挑出写类工具（write_file / edit_file）

   ★ 为什么要 diff 而不是「并排显示两段文字」：Agent 的两次生成往往 90% 相同，
     并把两段几千字放在一起没人看得下去 —— 差异那几行才是要看的。
   ★ 数据来源就是消息自带的 toolRuns（跟着会话落盘，重开也在），不另拉台账 ——
     台账那侧（任务/changeset）另有差异工具，这里服务的是「看两个回答版本」。
   ══════════════════════════════════════════════════════════════ */

export interface DiffRow {
  kind: 'same' | 'add' | 'del'
  text: string
}

export interface LineDiff {
  rows: DiffRow[]
  added: number
  removed: number
  /** 行数太多、只保留了前一段 */
  truncated: boolean
}

/**
 * 逐行 diff（最长公共子序列）。
 *
 * 规模兜底：DP 是 O(n×m)，两段各几千行会吃掉几 MB —— 超过阈值就退化成
 * 「按下标逐行比」—— 对「看差异」这个用途足够，且永远不会卡住界面。
 */
export function diffLines(oldText: string, newText: string, maxRows = 300): LineDiff {
  const a = String(oldText ?? '').split('\n')
  const b = String(newText ?? '').split('\n')

  const rows: DiffRow[] = []
  let added = 0
  let removed = 0

  if (a.length * b.length > 250_000) {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i += 1) {
      const x = a[i]
      const y = b[i]
      if (x === y) rows.push({ kind: 'same', text: x ?? '' })
      else {
        if (x !== undefined) {
          rows.push({ kind: 'del', text: x })
          removed += 1
        }
        if (y !== undefined) {
          rows.push({ kind: 'add', text: y })
          added += 1
        }
      }
    }
    return finish(rows, added, removed, maxRows)
  }

  /* LCS 表（(n+1)×(m+1) 的箭头表用长度表推） */
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i]! })
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: 'del', text: a[i]! })
      removed += 1
      i += 1
    } else {
      rows.push({ kind: 'add', text: b[j]! })
      added += 1
      j += 1
    }
  }
  for (; i < n; i += 1) {
    rows.push({ kind: 'del', text: a[i]! })
    removed += 1
  }
  for (; j < m; j += 1) {
    rows.push({ kind: 'add', text: b[j]! })
    added += 1
  }
  return finish(rows, added, removed, maxRows)
}

/** 相同的行太长会淹没差异 —— 保留差异附近的少量上下文，其余折成一行「…」 */
function finish(rows: DiffRow[], added: number, removed: number, maxRows: number): LineDiff {
  const out: DiffRow[] = []
  let run: DiffRow[] = []
  const flush = (): void => {
    if (run.length === 0) return
    if (run.length <= 4) out.push(...run)
    else {
      out.push(
        run[0]!,
        { kind: 'same', text: `…（省略 ${run.length - 3} 行相同内容）` },
        ...run.slice(-2),
      )
    }
    run = []
  }
  for (const row of rows) {
    if (row.kind === 'same') run.push(row)
    else {
      flush()
      out.push(row)
    }
  }
  flush()
  const truncated = out.length > maxRows
  return { rows: truncated ? out.slice(0, maxRows) : out, added, removed, truncated }
}

export interface ToolStep {
  name: string
  ok: boolean
  detail: string
}

/** 一条回答跑过的工具（按顺序） */
export function toolSequenceOf(record: StoredMessage | undefined): ToolStep[] {
  return (record?.toolRuns ?? []).map((run) => ({
    name: run.name,
    ok: run.ok !== false,
    detail: String(run.output ?? '')
      .split('\n')[0]!
      .slice(0, 90),
  }))
}

/** 工具序列的「对齐视图」：diff 两个序列，标出「多了 / 少了 / 换了」 */
export interface ToolSeqRow {
  kind: 'same' | 'onlyA' | 'onlyB' | 'diff'
  a?: ToolStep
  b?: ToolStep
}

export function alignToolSequences(a: ToolStep[], b: ToolStep[]): ToolSeqRow[] {
  const rows: ToolSeqRow[] = []
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x && y) rows.push({ kind: x.name === y.name ? 'same' : 'diff', a: x, b: y })
    else if (x) rows.push({ kind: 'onlyA', a: x })
    else if (y) rows.push({ kind: 'onlyB', b: y })
  }
  return rows
}

/** 可能是文件改动的那类工具（其余工具不动磁盘） */
const FILE_TOOLS = new Set(['write_file', 'edit_file'])

/** 从工具输出里抠一个路径出来（尽力而为；抠不到就退回输出首行） */
function pathFromOutput(output: string): string {
  const text = String(output ?? '')
  const win = text.match(/[A-Za-z]:\\[^\n"'（(]+/)
  if (win) return win[0].replace(/[。，、：)\s]+$/, '')
  const rel = text.match(/[^\s"'（(]+\.\w{1,10}/)
  return rel ? rel[0] : text.split('\n')[0]!.slice(0, 90)
}

/** 这条回答碰过的文件（从写类工具调用里归纳，同名合并计数） */
export function fileTouchesOf(
  record: StoredMessage | undefined,
): Array<{ file: string; count: number }> {
  const counts = new Map<string, number>()
  for (const run of record?.toolRuns ?? []) {
    if (!FILE_TOOLS.has(run.name)) continue
    const file = pathFromOutput(String(run.output ?? ''))
    counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  return [...counts.entries()].map(([file, count]) => ({ file, count }))
}
