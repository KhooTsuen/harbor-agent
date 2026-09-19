import { join, readFileSync, require, rmSync, ROOT, SANDBOX, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-036：Diff First ——「改之前先让用户看到会改成什么」

   文档原文三行：

     修改 → Diff → Test → Verify → Final Result
     必须让用户明确看到修改内容。

   而确认框原来只有一行摘要（`写文件 x（1291 字节）`）—— 看不出会改成什么样，
   点「允许」等于闭眼签。这一组盯三件事：

     · `diff-text.cjs`：行级 diff 算得对（行号、上下文、计数、大文件退路）
     · `write-diff.cjs`：`write_file` / `edit_file` 各能算出**真**预览
     · **接线**：写操作确认时 diff 真的跟着请求送到了弹窗那一层
       （单测里再准，没人调用也白搭 —— AG-027 的老教训）
   ══════════════════════════════════════════════════════════════ */

const diffText = require(join(ROOT, 'electron/core/diff-text.cjs'))
const writeDiff = require(join(ROOT, 'electron/core/write-diff.cjs'))
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))

const lines = (n, prefix = '行') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

export async function run() {
  /* ── ① 行级 diff ─────────────────────────────────────── */
  group('AG-036 / 行级 diff')

  const one = diffText.diffFile({ path: 'a.txt', before: '一\n二\n三', after: '一\n二改\n三' })
  check('改一行 → +1 −1', one.additions === 1 && one.deletions === 1)
  check('一个 hunk', one.hunks.length === 1)
  check(
    '上下文行两侧都在（三行文件全带上）',
    one.hunks[0].lines.map((l) => l.type).join('|') === 'context|remove|add|context',
  )
  check(
    '★ 行号：删除行只有旧行号、新增行只有新行号',
    JSON.stringify(
      one.hunks[0].lines.map((l) => [l.type, l.oldLineNumber ?? null, l.newLineNumber ?? null]),
    ) ===
      JSON.stringify([
        ['context', 1, 1],
        ['remove', 2, null],
        ['add', null, 2],
        ['context', 3, 3],
      ]),
  )
  check('hunk 头带起止（@@ -1,3 +1,3 @@）', one.hunks[0].header === '@@ -1,3 +1,3 @@')

  const pure = diffText.diffFile({ path: 'b.txt', before: '', after: '甲\n乙' })
  check('新文件 → 全是新增', pure.additions === 2 && pure.deletions === 0)
  check('新文件行号从 1 开始', pure.hunks[0].lines[0].newLineNumber === 1)

  check(
    '★ 末尾换行不算一行（否则每次 diff 都多一个假的 +1）',
    (() => {
      const r = diffText.diffFile({ path: 'c.txt', before: '甲\n乙\n', after: '甲\n乙\n' })
      return r.additions === 0 && r.deletions === 0 && r.hunks.length === 0
    })(),
  )
  check(
    'CRLF 与 LF 不算差异',
    diffText.diffFile({ path: 'd.txt', before: '甲\r\n乙', after: '甲\n乙' }).additions === 0,
  )

  /* 相隔很远的两处改动 → 两个 hunk；挨得近 → 合并成一个 */
  const far = lines(60)
  const farAfter = [...far]
  farAfter[5] = '改了'
  farAfter[50] = '也改了'
  const farDiff = diffText.diffFile({
    path: 'e.txt',
    before: far.join('\n'),
    after: farAfter.join('\n'),
  })
  check('隔得远的两处改动 → 两个 hunk', farDiff.hunks.length === 2, String(farDiff.hunks.length))
  check('两个 hunk 的计数相加 = 总数', farDiff.additions === 2 && farDiff.deletions === 2)

  const near = [...far]
  const nearAfter = [...near]
  nearAfter[10] = 'x'
  nearAfter[12] = 'y'
  check(
    '挨得近的改动合进一个 hunk',
    diffText.diffFile({ path: 'f.txt', before: near.join('\n'), after: nearAfter.join('\n') }).hunks
      .length === 1,
  )

  check(
    '★ 大改动走整块替换的退路（不卡住）',
    (() => {
      const before = lines(3000, 'old')
      const after = lines(3000, 'new')
      const r = diffText.diffFile({
        path: 'g.txt',
        before: before.join('\n'),
        after: after.join('\n'),
      })
      return r.additions === 3000 && r.deletions === 3000 && typeof r.note === 'string'
    })(),
  )
  check(
    '★ 只改一行的大文件仍逐行比（首尾剪掉后 DP 很小）',
    (() => {
      const before = lines(3000)
      const after = [...before]
      after[1500] = '改了这一行'
      const r = diffText.diffFile({
        path: 'h.txt',
        before: before.join('\n'),
        after: after.join('\n'),
      })
      return r.additions === 1 && r.deletions === 1 && !r.note && r.hunks.length === 1
    })(),
  )

  /* ── ② 写操作预览 ────────────────────────────────────── */
  group('AG-036 / 这次写会改成什么')
  const file = join(SANDBOX, 'preview.txt')
  writeFileSync(file, ['第一行', '第二行', '第三行', ''].join('\n'), 'utf8')

  const full = writeDiff.preview({
    tool: 'write_file',
    args: { path: 'preview.txt', content: '全新内容\n' },
    workdir: SANDBOX,
  })
  check(
    'write_file → 算得出 diff',
    full.diff?.[0]?.additions === 1 && full.diff?.[0]?.deletions === 3,
  )
  check('write_file 的 diff 指向那个文件', String(full.diff?.[0]?.path).endsWith('preview.txt'))

  const edited = writeDiff.preview({
    tool: 'edit_file',
    args: { path: 'preview.txt', oldText: '第二行', newText: '第二行（改过）' },
    workdir: SANDBOX,
  })
  check(
    'edit_file → 算得出 diff',
    edited.diff?.[0]?.additions === 1 && edited.diff?.[0]?.deletions === 1,
  )
  check(
    '★ edit_file 的行号是**文件里的真行号**（不是片段里的）',
    edited.diff[0].hunks[0].lines.some((l) => l.oldLineNumber === 2),
  )
  check(
    'edit_file 上下文带上前后行',
    edited.diff[0].hunks[0].lines
      .map((l) => l.content)
      .join('|')
      .includes('第一行'),
  )

  const fresh = writeDiff.preview({
    tool: 'write_file',
    args: { path: 'brand-new.txt', content: '甲\n乙\n' },
    workdir: SANDBOX,
  })
  check(
    '新建文件 → 全是新增 + 一句说明',
    fresh.diff?.[0]?.additions === 2 && fresh.note.includes('新文件'),
  )

  const stale = writeDiff.preview({
    tool: 'edit_file',
    args: { path: 'preview.txt', oldText: '这段文件里根本没有', newText: 'x' },
    workdir: SANDBOX,
  })
  check('★ 找不到原文 → 明说（不装成整篇 diff）', stale.note.includes('没找到'), stale.note)
  check(
    '找不到原文也给一份片段预览',
    stale.diff?.[0]?.additions === 1 && stale.diff?.[0]?.deletions === 1,
  )

  const big = writeDiff.preview({
    tool: 'write_file',
    args: { path: 'huge.txt', content: 'x' },
    workdir: SANDBOX,
  })
  writeFileSync(join(SANDBOX, 'huge.txt'), 'x'.repeat(2 * 1024 * 1024), 'utf8')
  const bigAgain = writeDiff.preview({
    tool: 'write_file',
    args: { path: 'huge.txt', content: 'y' },
    workdir: SANDBOX,
  })
  check(
    '★ 大文件不预览，但要说清原因',
    bigAgain.diff.length === 0 && bigAgain.note.includes('太大'),
    bigAgain.note,
  )
  rmSync(join(SANDBOX, 'huge.txt'), { force: true })
  check('小文件照常预览', big.diff.length === 1)

  check(
    '算不出来的工具（run_shell）给空',
    writeDiff.preview({ tool: 'run_shell', args: { command: 'ls' }, workdir: SANDBOX }).diff
      .length === 0,
  )

  /* ── ③ 接线：确认请求里真的带着 diff ─────────────────── */
  group('AG-036 / 接线（确认请求带着 diff）')
  const seen = []
  const ctx = {
    workdir: SANDBOX,
    permission: 'ask',
    sessionId: 'selftest-ag036',
    log: console,
    confirm: async (request) => {
      seen.push(request)
      return false /* 拒绝：只看请求长什么样，真写下去反而会污染沙箱 */
    },
  }

  await tools.execute('write_file', { path: 'preview.txt', content: '新的\n' }, ctx)
  const writeAsk = seen.find((r) => r.kind === 'write')
  check('写文件时确实问了用户', Boolean(writeAsk))
  check(
    '★ 请求里带着 diff（弹窗就靠它显示「查看 Diff」）',
    Array.isArray(writeAsk?.diff?.[0]?.hunks),
  )
  /*
   * ★ 形状必须是**数组** —— 这条是补的：第一版内核返回单个对象，
   *   渲染层 `Array.isArray(event.diff)` 直接把它丢了，界面上什么也没有
   *   （真机抓到，单测当时按对象断言所以是绿的）。
   */
  check('★ diff 是数组（渲染层的收法）', Array.isArray(writeAsk?.diff), typeof writeAsk?.diff)
  check('diff 的路径是被写的那份文件', String(writeAsk?.diff?.[0]?.path).endsWith('preview.txt'))
  check(
    '★ 拒绝了就不会真写（文件内容没动）',
    readFileSync(file, 'utf8').startsWith('第一行'),
    readFileSync(file, 'utf8').slice(0, 12),
  )

  seen.length = 0
  await tools.execute(
    'edit_file',
    { path: 'preview.txt', oldText: '第一行', newText: '第一行改' },
    ctx,
  )
  check(
    'edit_file 的确认也带 diff',
    Array.isArray(seen.find((r) => r.kind === 'write')?.diff?.[0]?.hunks),
  )
}
