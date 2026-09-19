/**
 * 行级 diff（AG-036 Diff First）
 *
 * 「改之前先让用户看到会改成什么」—— 要的不是摘要（`−3 +4 行`），是**内容**。
 * 这份输出直接喂给渲染层的 `DiffViewer`（和右栏审查标签是同一套结构）。
 *
 * ── 为什么自己写，不装库 ──
 * 依赖表很短（见 package.json 的 dependencies），而这里要的东西就一句话：
 * 「行级 LCS + 前后各三行上下文」。两百行以内能写完，不值得为它多一个依赖。
 *
 * ── 性能上的取舍 ──
 * LCS 是 O(n×m)。但真实场景里编辑几乎总在**局部**：先把首尾相同的行整段剪掉，
 * 剩下的才是要算的部分（改一行的大文件 → 1×1 的 DP）。剪完仍然很大就退化成
 * 「整块替换」并说明原因 —— 宁可不好看，也不能卡住确认弹窗。
 */

/** 剪掉首尾公共行之后，中段超过这个规模就不再逐行比（n×m） */
const MAX_CELLS = 400_000
/** hunk 前后各留几行上下文 */
const CONTEXT = 3

function normalize(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

function splitLines(text) {
  /* 空文本 = 没有行 —— 不然「空文件」会被当成一个空行，新文件凭空多一个删除 */
  if (String(text ?? '') === '') return []
  const lines = normalize(text).split('\n')
  /*
   * 结尾那个换行会多出一个空串 —— 不剔掉的话，每次 diff 都会凭空多一行新增，
   * 「+1」这种假计数会让用户以为改了什么其实没改的地方。
   */
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 一行的「类型 + 内容」（行号后面统一编） */
const same = (text) => ({ type: 'context', content: text })
const del = (text) => ({ type: 'remove', content: text })
const add = (text) => ({ type: 'add', content: text })

/**
 * 中段的 LCS（返回操作序列）。
 * 只在「剪掉首尾公共行之后」的小块上调用 —— 大块由调用方退化处理。
 */
function lcsOps(oldLines, newLines) {
  const n = oldLines.length
  const m = newLines.length
  /* dp[i][j] = oldLines[i..] 与 newLines[j..] 的 LCS 长度 */
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push(same(oldLines[i]))
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(del(oldLines[i]))
      i += 1
    } else {
      ops.push(add(newLines[j]))
      j += 1
    }
  }
  for (; i < n; i += 1) ops.push(del(oldLines[i]))
  for (; j < m; j += 1) ops.push(add(newLines[j]))
  return ops
}

/** 整块替换（大改动 / 超限时的退路） */
function replaceAll(oldLines, newLines) {
  return [...oldLines.map(del), ...newLines.map(add)]
}

/**
 * 把操作序列切成 hunk（隔得远的改动各自成块，上下各留 CONTEXT 行）。
 *
 * 行号**整篇先编好再切片** —— 在切片里自己数偏移量，错一次就少一个上下文行，
 * 而那种错在界面上看不出来（只是行号对不上）。
 */
function toHunks(ops) {
  const marks = ops
    .map((op, index) => (op.type === 'context' ? -1 : index))
    .filter((index) => index >= 0)
  if (marks.length === 0) return []

  /* 改动点之间距离 <= 2×CONTEXT 的合并进同一个 hunk */
  const ranges = []
  for (const index of marks) {
    const last = ranges[ranges.length - 1]
    if (last && index - last.end <= CONTEXT * 2) last.end = index
    else ranges.push({ start: index, end: index })
  }

  const numbered = []
  let oldNo = 1
  let newNo = 1
  for (const op of ops) {
    const line = { type: op.type, content: op.content }
    if (op.type !== 'add') line.oldLineNumber = oldNo
    if (op.type !== 'remove') line.newLineNumber = newNo
    if (op.type !== 'add') oldNo += 1
    if (op.type !== 'remove') newNo += 1
    numbered.push(line)
  }

  return ranges.map(({ start, end }) => {
    const from = Math.max(0, start - CONTEXT)
    const to = Math.min(numbered.length - 1, end + CONTEXT)
    const lines = numbered.slice(from, to + 1)
    const oldCount = lines.filter((line) => line.type !== 'add').length
    const newCount = lines.filter((line) => line.type !== 'remove').length
    const firstOld = lines.find((line) => line.oldLineNumber !== undefined)?.oldLineNumber ?? 0
    const firstNew = lines.find((line) => line.newLineNumber !== undefined)?.newLineNumber ?? 0
    return { header: `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`, lines }
  })
}

/**
 * 算一个文件的 diff。
 *
 * @param {{ path?: string, before?: string, after?: string }} input
 * @returns {{ path: string, additions: number, deletions: number, hunks: array, note?: string }}
 */
function diffFile({ path = '', before = '', after = '' } = {}) {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)

  /* ① 剪掉首尾相同的行 —— 大部分编辑的 DP 会缩到几行×几行 */
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head])
    head += 1
  let tail = 0
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1
  }

  const midOld = oldLines.slice(head, oldLines.length - tail)
  const midNew = newLines.slice(head, newLines.length - tail)
  /*
   * 只看**中段**的规模 —— 别拿整篇行数当门槛：改一行的大文件剪完只剩 1×1，
   * 逐行比毫无压力（第一版加了「总行数 > 4000 就整块替换」，结果三千行文件里
   * 改一行也被判成「改动很大」，白白丢掉漂亮的 diff）。
   */
  const tooBig = midOld.length * midNew.length > MAX_CELLS

  const ops = [
    ...oldLines.slice(0, head).map(same),
    ...(tooBig ? replaceAll(midOld, midNew) : lcsOps(midOld, midNew)),
    ...oldLines.slice(oldLines.length - tail).map(same),
  ]

  const additions = ops.filter((op) => op.type === 'add').length
  const deletions = ops.filter((op) => op.type === 'remove').length
  const result = { path: String(path), additions, deletions, hunks: toHunks(ops) }
  if (tooBig) result.note = '这段改动很大，按整块替换显示（没有逐行比对）'
  return result
}

module.exports = { diffFile, splitLines, MAX_CELLS, CONTEXT }
