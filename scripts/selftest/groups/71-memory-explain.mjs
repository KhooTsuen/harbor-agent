/**
 * 自检 / 记忆可解释（explain · lastInjection）
 *
 * 这一组钉住四件事：
 *   ① 解释里的分数就是排序用的分数（同一次查询，两种模式的顺序必须一模一样）
 *   ② 理由是**人话**（中文 label + 数字 weight + 说明），且各项 weight 之和就是 score
 *   ③ 权重为 0 的信号不许进理由（说它「起了作用」是假话）
 *   ④ 老接口没被改坏：不传 explain 还是裸 item 数组；没注入过是 null、
 *      一条都没注入是**结构完整的空账**（界面读到 null 会崩）
 *
 * 数据隔离：store 没有内存模式，这一组是在**真实** data/memory.json 上跑的，
 * 所以「先按原样备份整份 JSON，finally 还原」—— 中途炸了也不会吃掉用户的记忆。
 * 备份用原始文本，不用 memory.read()（那个只留 content，类型/范围/时间全丢）。
 *
 * 注意：这一组**没有**注册进 scripts/selftest.mjs（接线由主代理做）。
 * 单独跑：
 *   node -e "import('./scripts/selftest/groups/71-memory-explain.mjs').then(m=>m.run())"
 */

import { existsSync, join, readFileSync, rmSync, writeFileSync, ROOT, require } from '../env.mjs'
import { check, group } from '../harness.mjs'
/* 纯函数与接口形态的断言在零件文件里（合并会让本文件顶破 300 行红线） */
import { runLegacyShapeChecks, runReasonChecks, runSummaryChecks } from './71-memory-explain-parts.mjs'

const store = require(join(ROOT, 'electron/core/memory-store.cjs'))
const recall = require(join(ROOT, 'electron/core/memory-recall.cjs'))
const explainer = require(join(ROOT, 'electron/core/memory-explain.cjs'))

/** 原样备份 memory.json（它本来可能就不存在） */
function snapshot() {
  if (!existsSync(store.filePath())) return { existed: false, text: '' }
  return { existed: true, text: readFileSync(store.filePath(), 'utf8') }
}

function restore(backup) {
  if (backup.existed) writeFileSync(store.filePath(), backup.text, 'utf8')
  else rmSync(store.filePath(), { force: true })
}

/** 造一条记忆；写不进去就立刻抛，别让后面的断言莫名其妙地失败 */
function seed(input) {
  const result = store.add(input)
  if (!result.ok) throw new Error(`造数据失败：${input.content} —— ${result.error}`)
  return result.item
}

/* 提问和其中一条记忆刻意用同一句话，这样「重合度」这一项一定 > 0 */
const QUERY = '提交前必须跑 npm run verify 吗'

export async function run() {
  const backup = snapshot()

  try {
    /* ══ 1. 分数即排序 ══════════════════════════════════════ */

    group('记忆可解释 / 解释的分就是排序的分')
    store.clear()
    const items = [
      seed({ content: '提交前必须跑 npm run verify', type: 'constraint', scope: 'session', importance: 0.9 }),
      seed({ content: '回答尽量短，别写成小作文', type: 'preference', scope: 'global', importance: 0.4 }),
      seed({
        content: '部署脚本放在 scripts/deploy.mjs',
        type: 'fact',
        scope: 'workspace',
        importance: 0.1,
        confidence: 0.5,
      }),
      seed({ content: '不要自动改 CHANGELOG.md', type: 'project_rule', scope: 'task', importance: 0.6 }),
      seed({ content: '写代码注释一律用中文', type: 'habit', scope: 'global', importance: 0.3, confidence: 0.8 }),
    ]
    /*
     * limit 故意小于条数：条数没到预算时 retrieve 走「不打分」的短路分支，
     * 那条路径根本没有排序，测不出「分数一致」。3 < 5 才会真的打分。
     */
    const plain = recall.retrieve({ query: QUERY, limit: 3 })
    const explained = recall.retrieve({ query: QUERY, limit: 3, explain: true })

    check(
      'explain: true 返回 [{ item, score, reasons }]',
      explained.length === 3 &&
        explained.every((e) => e.item && typeof e.score === 'number' && Array.isArray(e.reasons)),
      JSON.stringify(explained[0]?.score),
    )
    check(
      '★ 两种模式给出的 id 顺序完全一致',
      plain.map((i) => i.id).join(',') === explained.map((e) => e.item.id).join(','),
      `${plain.map((i) => i.id).join(',')} ≠ ${explained.map((e) => e.item.id).join(',')}`,
    )
    check(
      '★ explain 的 score 与 scoreOf（排序用的那个）逐位相等',
      explained.every((e) => {
        const at = Date.now()
        return (
          explainer.explain(e.item, { query: QUERY, now: at }).score ===
          explainer.scoreOf(e.item, { query: QUERY, now: at })
        )
      }),
    )
    check(
      '返回的是按分数降序的前 3 条',
      explained.every((e, idx) => idx === 0 || explained[idx - 1].score >= e.score),
    )
    check('最相关的就是那条约束（分数真的在起作用）', explained[0].item.type === 'constraint', explained[0].item.type)

    /* ══ 2. 理由的形状 ══════════════════════════════════════ */

    runReasonChecks({ explainer, items, explained, query: QUERY })

    /* ══ 3. 一句话总结 ══════════════════════════════════════ */

    runSummaryChecks({ explainer, explained })

    /* ══ 4. 老接口回归 ══════════════════════════════════════ */

    runLegacyShapeChecks({ recall, query: QUERY })

    /* ══ 5. 注入账 ══════════════════════════════════════════ */

    group('记忆可解释 / 注入账（lastInjection）')
    check(
      '注入之前 lastInjection() 要么是 null、要么结构完整（不是别的东西）',
      (() => {
        const before = recall.lastInjection()
        return (
          before === null ||
          (Array.isArray(before.injected) && typeof before.budget === 'number' && typeof before.at === 'number')
        )
      })(),
    )
    const section = recall.buildPromptSection({ query: QUERY })
    const record = recall.lastInjection()
    check(
      '注入了就有一本账（at / budget / total / injected）',
      record !== null &&
        typeof record.at === 'number' &&
        typeof record.budget === 'number' &&
        typeof record.total === 'number' &&
        Array.isArray(record.injected),
      JSON.stringify({ budget: record?.budget, total: record?.total, injected: record?.injected?.length }),
    )
    check('5 条记忆都在预算内，全进来了', record.injected.length === 5, String(record.injected.length))
    check(
      '★ 提示文本里出现过的每条记忆都在账上',
      store
        .list({ status: 'active' })
        .filter((i) => section.includes(i.content))
        .every((i) => record.injected.some((x) => x.id === i.id)),
    )
    check(
      '★ 账上的每条也都真的进了提示文本',
      record.injected.every((x) => {
        const item = store.list({ includeSuperseded: true }).find((i) => i.id === x.id)
        return Boolean(item) && section.includes(item.content)
      }),
    )
    check(
      '账里每条都带 type / scope / score / 一句话 reason，content 截到 60 字',
      record.injected.every(
        (x) =>
          typeof x.type === 'string' &&
          typeof x.scope === 'string' &&
          typeof x.score === 'number' &&
          typeof x.reason === 'string' &&
          x.reason.length > 0 &&
          x.content.length <= 60,
      ),
    )
    check(
      '账是只读快照：改它不影响内核里的那份',
      (() => {
        const copy = recall.lastInjection()
        copy.injected.length = 0
        return recall.lastInjection().injected.length === 5
      })(),
    )

    /* ══ 6. 空账与项目范围 ══════════════════════════════════ */

    group('记忆可解释 / 空账与项目范围')
    store.clear()
    check(
      '★ 一条记忆都没有时：提示段为空，但账是**结构完整的空账**（不是 null）',
      (() => {
        const emptySection = recall.buildPromptSection({ query: QUERY })
        const emptyRecord = recall.lastInjection()
        return (
          emptySection === '' &&
          emptyRecord !== null &&
          Array.isArray(emptyRecord.injected) &&
          emptyRecord.injected.length === 0 &&
          typeof emptyRecord.budget === 'number' &&
          emptyRecord.total === 0
        )
      })(),
    )
    const projectItem = seed({
      content: '这个项目的部署走 scripts/deploy.mjs',
      type: 'project_rule',
      scope: 'project',
      projectId: 'proj-a',
      importance: 0.6,
    })
    check(
      '★ 没有项目上下文时，project 范围的记忆不进来（现有语义，防回归）',
      recall.retrieve({ query: '部署', limit: 5 }).every((i) => i.id !== projectItem.id),
    )
    check(
      'explain 模式下也一样被挡住，提示文本里也没有它',
      recall.retrieve({ query: '部署', limit: 5, explain: true }).every((e) => e.item.id !== projectItem.id) &&
        recall.buildPromptSection({ query: '部署' }).includes(projectItem.content) === false,
    )
    check(
      '给了 projectId 才带进来',
      recall.retrieve({ query: '部署', projectId: 'proj-a', limit: 5 }).some((i) => i.id === projectItem.id),
    )
    check(
      '别的项目看不到它',
      recall.retrieve({ query: '部署', projectId: 'proj-b', limit: 5 }).every((i) => i.id !== projectItem.id),
    )

    /* ══ 7. 预算上限 ═══════════════════════════════════════ */

    group('记忆可解释 / 预算上限')
    store.clear()
    const budget = recall.injectLimit()
    for (let i = 0; i < budget + 3; i += 1) {
      store.add({ content: `第 ${i} 条占位：跟本次提问无关的事`, type: 'fact', scope: 'global' })
    }
    const overSection = recall.buildPromptSection({ query: '第七组测试用的提问' })
    const overRecord = recall.lastInjection()
    check(
      '★ 超预算时注入条数不超过预算',
      overRecord.injected.length <= overRecord.budget,
      `${overRecord.injected.length} > ${overRecord.budget}`,
    )
    check(
      '★ 超预算时正好注满预算（不多不少）',
      overRecord.injected.length === overRecord.budget,
      String(overRecord.injected.length),
    )
    check('total 报的是当时 active 的总数', overRecord.total === budget + 3, String(overRecord.total))
    check('预算写进了给模型的提示里', overSection.includes(`本轮最多注入 ${budget} 条`), overSection.slice(-160))
    check(
      '没进来的条数也数得清（提示里写了剩下几条）',
      overSection.includes(`${overRecord.total - overRecord.injected.length} 条没进来`),
      overSection.slice(-160),
    )
  } finally {
    /* 无论中途炸在哪，都要把用户的记忆原样放回去 */
    restore(backup)
  }

  group('记忆可解释 / 数据隔离')
  const after = snapshot()
  check(
    '跑完把用户的 data/memory.json 原样还原了（没留下测试数据）',
    backup.existed ? after.existed && after.text === backup.text : !after.existed,
    backup.existed ? `备份 ${backup.text.length} 字，现在 ${after.text.length} 字` : '本来没有 memory.json，现在也应该没有',
  )
}
