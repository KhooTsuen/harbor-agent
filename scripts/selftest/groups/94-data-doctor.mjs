/**
 * 自检 / 数据体检（Data Doctor）
 *
 * 这一组干三件事：
 *   ① **造一份「各种坏法都齐了」的 data 目录**，断言每一种问题都被认出来 ——
 *      光测「正常数据没问题」是不够的：那样的实现永远返回空数组也能过。
 *   ② 断言**分级是对的**：删任务/删对话留下的悬空引用是 `warn`（可以清），
 *      清单与文件对不上是 `error`（真出事了）。混在一起用户第一次跑就被吓到。
 *   ③ 断言**它真的只读** —— 跑前跑后文件清单逐字节一样。
 *      这条是这份工具最要紧的承诺：一个会「顺手修一下」的体检工具，
 *      比没有体检更危险。
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, require } from '../env.mjs'

const doctor = require(join(ROOT, 'electron/core/data-doctor.cjs'))

/** 造文件（自动建目录） */
function put(file, text) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

/** 目录快照：相对路径 + 字节数，用来证明「跑一遍什么都没动」 */
function snapshot(dir, prefix = '', out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    let entries
    try {
      entries = readdirSync(full)
    } catch {
      out.push([`${prefix}${name}`, readFileSync(full).length])
      continue
    }
    snapshot(full, `${prefix}${name}/`, out)
    if (entries.length === 0) out.push([`${prefix}${name}/`, 0])
  }
  return out
}

/** 干净的一份：只有对得上的东西 */
function buildClean(root) {
  put(join(root, 'tasks/task_ok.json'), JSON.stringify({ id: 'task_ok', sessionId: 'sess_ok' }))
  put(join(root, 'tasks/_index.json'), JSON.stringify({ version: 1, items: [{ id: 'task_ok' }] }))
  put(join(root, 'sessions/sess_ok.jsonl'), '{"role":"user","content":"你好"}\n')
  put(
    join(root, 'changesets/cs_ok/meta.json'),
    JSON.stringify({ id: 'cs_ok', taskId: 'task_ok', files: [{ path: 'a.txt', snap: '1.snap' }] }),
  )
  put(join(root, 'changesets/cs_ok/files/1.snap'), 'old\n')
  put(
    join(root, 'artifacts/art_ok/meta.json'),
    JSON.stringify({ id: 'art_ok', taskId: 'task_ok', versions: [{ version: 1 }] }),
  )
  put(join(root, 'artifacts/art_ok/v1.md'), '正文\n')
}

/** 坏的那份：每种坏法各一处 */
function buildBroken(root) {
  buildClean(root)
  /* 任务：一个指向不存在的会话、一个 JSON 坏了 */
  put(join(root, 'tasks/task_orphan.json'), JSON.stringify({ id: 'task_orphan', sessionId: 'sess_gone' }))
  put(join(root, 'tasks/task_broken.json'), '{ 这不是 JSON')
  /* 会话：最后一行是写了一半的 */
  put(join(root, 'sessions/sess_bad.jsonl'), '{"role":"user","content":"在吗"}\n{"role":"assistant","conte')
  /* 改动事务：目录没清单 / 清单坏了 / 快照丢了 + 任务不在了 */
  mkdirSync(join(root, 'changesets/cs_nometa'), { recursive: true })
  put(join(root, 'changesets/cs_broken/meta.json'), '{ 坏')
  put(
    join(root, 'changesets/cs_base/meta.json'),
    JSON.stringify({ id: 'cs_base', taskId: 'task_gone', files: [{ path: 'b.txt', snap: '9.snap' }] }),
  )
  mkdirSync(join(root, 'changesets/cs_base/files'), { recursive: true })
  /* 成果：少一版正文 / 清单坏了 */
  put(
    join(root, 'artifacts/art_missing/meta.json'),
    JSON.stringify({ id: 'art_missing', taskId: 'task_ok', versions: [{ version: 1 }, { version: 2 }] }),
  )
  put(join(root, 'artifacts/art_missing/v1.md'), '只有第一版\n')
  put(join(root, 'artifacts/art_broken/meta.json'), '{ 坏')
  /* 成果：归属的任务和会话都不在了 */
  put(
    join(root, 'artifacts/art_gone/meta.json'),
    JSON.stringify({ id: 'art_gone', taskId: 'task_gone', sessionId: 'sess_gone', versions: [] }),
  )
  /* 索引：少记了一条（task_orphan）—— 列任务时会整体重建，但体检该报出来 */
  put(join(root, 'tasks/_index.json'), JSON.stringify({ version: 1, items: [{ id: 'task_ok' }] }))
}

export function run() {
  group('数据体检 / 干净的数据一句话带过')
  const clean = join(SANDBOX, 'doctor-clean')
  rmSync(clean, { recursive: true, force: true })
  buildClean(clean)
  const cleanReport = doctor.run({ root: clean })
  check('干净的 data → 一条问题都没有', cleanReport.problems.length === 0, JSON.stringify(cleanReport.problems))
  check('ok 为真', cleanReport.ok === true)
  check('数量数对了（任务 1 / 会话 1 / 事务 1 / 成果 1 / 索引 1）', (() => {
    const c = cleanReport.counts
    return c.tasks === 1 && c.sessions === 1 && c.changesets === 1 && c.artifacts === 1 && c.indexItems === 1
  })())
  check('给人看的报告里写明了「不动数据」', doctor.format(cleanReport).includes('只报告，不动数据'))

  group('数据体检 / 每种坏法都要认出来')
  const bad = join(SANDBOX, 'doctor-broken')
  rmSync(bad, { recursive: true, force: true })
  buildBroken(bad)
  const report = doctor.run({ root: bad })
  const kinds = new Set(report.problems.map((item) => item.kind))
  const expect = [
    'task_json_broken',
    'task_session_missing',
    'session_tail_broken',
    'changeset_no_meta',
    'changeset_meta_broken',
    'changeset_snapshot_missing',
    'changeset_task_missing',
    'artifact_version_missing',
    'artifact_meta_broken',
    'artifact_scope_missing',
    'index_drift',
  ]
  for (const kind of expect) check(`认出 ${kind}`, kinds.has(kind))
  check(
    '坏的那份 ok 为假（有 error 级问题）',
    report.ok === false && report.counts.errors > 0,
  )
  check(
    '坏文件不计入数量（读不动的不算「有这条任务」）',
    report.counts.tasks === 2,
    String(report.counts.tasks),
  )

  group('数据体检 / 分级：删东西留下的不算「坏了」')
  const levelOf = (kind) => report.problems.find((item) => item.kind === kind)?.level
  check('★ 悬空引用是 warn —— 删任务本来就会留下它', levelOf('changeset_task_missing') === 'warn')
  check('悬空会话是 warn', levelOf('task_session_missing') === 'warn')
  check('★ 清单与文件对不上是 error', levelOf('changeset_snapshot_missing') === 'error')
  check('坏 JSON 是 error', levelOf('task_json_broken') === 'error')
  check('索引漂移是 error', levelOf('index_drift') === 'error')
  check('报告里两类措辞不同（对不上 / 提示）', (() => {
    const text = doctor.format(report)
    return text.includes('[对不上]') && text.includes('[提示]')
  })())

  /*
   * ok 只反映 `error`。只有悬空引用（删过东西）时它必须是 true ——
   * 否则用户每次体检都会看到「失败」，久而久之就不看了。
   */
  const warnOnly = join(SANDBOX, 'doctor-warn-only')
  rmSync(warnOnly, { recursive: true, force: true })
  buildClean(warnOnly)
  put(join(warnOnly, 'tasks/task_orphan.json'), JSON.stringify({ id: 'task_orphan', sessionId: 'sess_gone' }))
  put(
    join(warnOnly, 'tasks/_index.json'),
    JSON.stringify({ version: 1, items: [{ id: 'task_ok' }, { id: 'task_orphan' }] }),
  )
  const warnReport = doctor.run({ root: warnOnly })
  check(
    '★ 只有悬空引用时 ok 仍为真（别让用户每次看到「失败」）',
    warnReport.ok === true && warnReport.problems.length === 1 && warnReport.problems[0].level === 'warn',
    JSON.stringify(warnReport.problems),
  )

  group('数据体检 / ★ 只读：跑一遍什么都没动')
  const before = snapshot(bad)
  doctor.run({ root: bad })
  doctor.run({ root: bad })
  const after = snapshot(bad)
  check('★ 跑两遍之后，文件清单 + 字节数逐项一致', JSON.stringify(before) === JSON.stringify(after))
  const cleanBefore = snapshot(clean)
  doctor.run({ root: clean })
  check('干净的那份也没被动过', JSON.stringify(cleanBefore) === JSON.stringify(snapshot(clean)))

  group('数据体检 / 读不动的目录不当崩溃')
  const emptyRoot = join(SANDBOX, 'doctor-empty')
  rmSync(emptyRoot, { recursive: true, force: true })
  mkdirSync(emptyRoot, { recursive: true })
  const empty = doctor.run({ root: emptyRoot })
  check('空目录：0 条问题、不抛错', empty.problems.length === 0 && empty.counts.tasks === 0)
  const ghost = doctor.run({ root: join(SANDBOX, '根本没有这个目录') })
  check('目录根本不存在也不抛错', ghost.ok === true && ghost.counts.sessions === 0)

  group('数据体检 / ★ 同类多了要归拢（不然没人看第二眼）')
  const many = join(SANDBOX, 'doctor-many')
  rmSync(many, { recursive: true, force: true })
  buildClean(many)
  for (let i = 0; i < 25; i += 1) {
    put(
      join(many, `changesets/cs_orphan${i}/meta.json`),
      JSON.stringify({ id: `cs_orphan${i}`, taskId: 'task_gone', files: [] }),
    )
  }
  const flood = doctor.run({ root: many })
  check('★ 总数算全（25 个孤儿事务一个不少）', flood.totals.changeset_task_missing === 25, JSON.stringify(flood.totals))
  check(
    `明细每类最多留 ${doctor.MAX_PER_KIND} 条`,
    flood.problems.filter((item) => item.kind === 'changeset_task_missing').length === doctor.MAX_PER_KIND,
  )
  check('truncated 标出来（没把「只列了 20 条」说成「就 20 个」）', flood.truncated === true)
  check('kinds 里带人话标签', (() => {
    const row = flood.kinds.find((item) => item.kind === 'changeset_task_missing')
    return row?.label === '改动事务的任务不在了' && row?.count === 25 && row?.level === 'warn'
  })())
  const floodText = doctor.format(flood)
  check('报告按类型归拢成一行（25 个）', floodText.includes('（25 个）'))
  check('并说明还有多少没列出来', floodText.includes('同类还有 5 个'))
  check('报告行数远小于问题数（别一条一行）', floodText.split('\n').length < 15, String(floodText.split('\n').length))
}
