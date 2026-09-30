/**
 * 数据体检的**报告层**：类型标签 + 怎么把结果摆给人看
 *
 * 从 `data-doctor.cjs` 拆出来的（那边加完检查就 358 行了，顶穿硬约束 #2）。
 * 缝在这里：**「查什么」和「怎么说是两件事」** ——
 * 检查（读目录、比清单、认坏 JSON）住在 `data-doctor.cjs`，
 * 措辞和归拢（哪些先显示、每类给几条、人话标签叫什么）住在这里。
 *
 * 拆的时候的讲究：
 *   · `LABELS` 跟着报告走 —— 它**只**用来显示（检查那边只借它填 `label` 字段），
 *     改一句人话不用去动读文件的那段代码
 *   · `MAX_PER_KIND` 也在这里：它同时决定「留几条明细」和「屏幕上一类显示几行」，
 *     两个数必须相等，否则会出现「存了 20 条但只显示 3 条、还说自己列全了」
 */

/**
 * 每一种问题的人话标签。
 *
 * 和 `errors.cjs` 的分类表同一个思路：**类型码是给程序看的，标签是给人看的**。
 * 报告按类型归拢时就拿它当小标题 —— 而不是从第一条明细里裁字符串（裁出来的是 id，不是结论）。
 */
const LABELS = {
  task_json_broken: '任务文件读不动',
  task_session_missing: '任务的会话文件不在了',
  session_tail_broken: '会话最后一行不完整',
  changeset_no_meta: '改动事务缺 meta.json',
  changeset_meta_broken: '改动事务的 meta.json 读不动',
  changeset_snapshot_missing: '改动事务的快照文件不见了',
  changeset_task_missing: '改动事务的任务不在了',
  artifact_no_meta: '成果缺 meta.json',
  artifact_meta_broken: '成果的 meta.json 读不动',
  artifact_version_missing: '成果的正文版本文件不见了',
  artifact_scope_missing: '成果的归属（任务 / 会话）都不在了',
  index_broken: '任务索引读不动',
  index_drift: '任务索引和磁盘对不上',
}

/**
 * 同类问题最多收录几条。
 *
 * 为什么：真机上第一跑就碰上「127 个改动事务的任务不在了」—— 127 行同款提示
 * 正是「让人不再看这份报告」的写法。所以：**条数算全，明细每类只留前 20 条**，
 * 报告里按类型归拢成一行（带几个例子）。数字不会少算，屏幕不会刷屏。
 */
const MAX_PER_KIND = 20
/** 一类最多列几个例子（再多就没人看了） */
const SAMPLES = 3

/**
 * 报告 → 给人看的几行（命令行和界面共用同一份措辞）。
 *
 * 按**类型**归拢而不是一条一行：真机上第一次跑就有 127 个同款问题，
 * 逐条铺开等于没报。每类给「共几个」+ 最多几个例子。
 */
function format(report) {
  const c = report.counts ?? {}
  const lines = [
    `Harbor 数据体检 —— ${report.root}`,
    `  任务 ${c.tasks ?? 0} · 会话 ${c.sessions ?? 0} · 改动事务 ${c.changesets ?? 0} · 成果 ${c.artifacts ?? 0} · 索引 ${c.indexItems ?? 0} 条`,
    '',
  ]
  const kinds = report.kinds ?? []
  if (kinds.length === 0) {
    lines.push('✓ 没发现对不上的地方')
  } else {
    const total = kinds.reduce((sum, row) => sum + row.count, 0)
    lines.push(`要看一下的有 ${total} 处（按类型归拢）：`)
    /* 先「对不上」后「提示」：前者是真出事了，后者多半是删过东西留下的；同类里多的在前 */
    const rows = [...kinds].sort((a, b) =>
      a.level === b.level ? b.count - a.count : a.level === 'error' ? -1 : 1,
    )
    for (const row of rows) {
      lines.push(`  [${row.level === 'error' ? '对不上' : '提示'}] ${row.label}（${row.count} 个）`)
      const samples = (report.problems ?? []).filter((item) => item.kind === row.kind)
      for (const item of samples.slice(0, SAMPLES)) lines.push(`        · ${item.detail}`)
      const hint = samples.find((item) => item.hint)?.hint
      if (hint) lines.push(`        说明：${hint}`)
      if (row.count > samples.length) {
        lines.push(`        （同类还有 ${row.count - samples.length} 个，--json 能看全）`)
      }
    }
  }
  /* 这句两种情形都要有：它是这份工具最要紧的承诺 */
  lines.push('')
  lines.push('只报告，不动数据。要清哪些、清不清，你说了算。')
  return lines.join('\n')
}

module.exports = { LABELS, MAX_PER_KIND, SAMPLES, format }
