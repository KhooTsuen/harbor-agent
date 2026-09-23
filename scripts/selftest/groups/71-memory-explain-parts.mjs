/**
 * 自检 / 记忆可解释：纯函数与接口形态（71-memory-explain 的零件）
 *
 * 为什么拆出来：71 那一组要真实读写 data/memory.json（备份 → 跑 → 还原），
 * 把「打分和文案本身对不对」跟「端到端通不通」挤在一个文件里会顶破 300 行红线。
 * 拆开之后失败也更好读：这里红了 = 打分 / 文案错了；71 红了 = 接线或真实数据路径错了。
 *
 * 子组标题与断言文案原样保留（免得既有的失败清单对不上号）。
 */

import { check, group } from '../harness.mjs'

/**
 * 理由的形状：人话、账要对得上、0 分项不许算「起了作用」。
 *
 * @param {{ explainer: object, items: Array, explained: Array, query: string }} input
 */
export function runReasonChecks({ explainer, items, explained, query }) {
  group('记忆可解释 / 理由是人话')
  check(
    '★ 每条理由都有 key / 中文 label / 数字 weight / 说明文字',
    explained.every(
      (e) =>
        e.reasons.length > 0 &&
        e.reasons.every(
          (r) =>
            typeof r.key === 'string' &&
            /[\u4e00-\u9fa5]/.test(String(r.label)) &&
            typeof r.weight === 'number' &&
            typeof r.detail === 'string' &&
            r.detail.length > 0,
        ),
    ),
  )
  check(
    '★ 各项 weight 之和就是 score（不然账对不上）',
    explained.every((e) => Math.abs(e.reasons.reduce((sum, r) => sum + r.weight, 0) - e.score) < 1e-9),
  )

  const at = Date.now()
  const own = explainer.explain(items[0], { query: '', now: at })
  const byKey = (key) => own.reasons.find((r) => r.key === key)
  check(
    '约束类型拿满 4 分，理由是「约束类记忆优先被遵守」',
    byKey('type')?.weight === 4 && byKey('type')?.detail.includes('约束类记忆优先被遵守'),
    JSON.stringify(byKey('type')),
  )
  check(
    'session 范围拿满 5 分，标签是「本次会话」',
    byKey('scope')?.weight === 5 && byKey('scope')?.label === '本次会话',
    JSON.stringify(byKey('scope')),
  )
  check('重要度 0.9 → 1.8 分', byKey('importance')?.weight === 1.8, JSON.stringify(byKey('importance')))
  check(
    '刚记下的新鲜度接近 1 分，理由写着「今天记的」',
    byKey('freshness')?.weight > 0.99 && byKey('freshness')?.detail.includes('今天'),
    JSON.stringify(byKey('freshness')),
  )
  check(
    '没有提问时重合度按基准 0.5 记（3 分），并写明它不影响排序',
    byKey('overlap')?.weight === 3 && byKey('overlap')?.detail.includes('不影响排序'),
    JSON.stringify(byKey('overlap')),
  )

  const asked = explainer.explain(items[0], { query, now: at })
  const overlapReason = asked.reasons.find((r) => r.key === 'overlap')
  check(
    '有提问时重合度是真算的（高于基准），写成「关键词重合 N%」',
    overlapReason.weight > 3 && /关键词重合 \d+%/.test(overlapReason.detail),
    JSON.stringify(overlapReason),
  )
  check(
    '★ 权重为 0 的信号不进理由（重要度 0 / 可信度 0 时不说它「起了作用」）',
    (() => {
      const zero = explainer.explain(
        { content: 'x', type: 'fact', scope: 'global', importance: 0, confidence: 0, createdAt: at },
        { now: at },
      )
      return (
        zero.reasons.every((r) => r.weight > 0) &&
        zero.reasons.some((r) => r.key === 'importance') === false &&
        zero.reasons.some((r) => r.key === 'confidence') === false
      )
    })(),
  )
  check(
    '未知类型 / 未知范围不炸，且按默认权重 1 算',
    (() => {
      const weird = explainer.explain(
        { content: 'x', type: '乱写的类型', scope: '乱写的范围', importance: 0.5, createdAt: at },
        { now: at },
      )
      return (
        weird.reasons.find((r) => r.key === 'type').weight === 1 &&
        weird.reasons.find((r) => r.key === 'scope').weight === 1 &&
        weird.score > 0
      )
    })(),
  )
}

/**
 * 一句话总结：非空、≤ 40 字、说人话、脏入参不炸。
 *
 * @param {{ explainer: object, explained: Array }} input
 */
export function runSummaryChecks({ explainer, explained }) {
  group('记忆可解释 / 一句话总结')
  const summaries = explained.map((e) => explainer.summarize({ reasons: e.reasons }))
  check(
    '★ 每条都有非空的总结',
    summaries.every((s) => typeof s === 'string' && s.trim().length > 0),
    JSON.stringify(summaries),
  )
  check(
    '★ 一句话 ≤ 40 字（界面那一行）',
    summaries.every((s) => s.length <= 40),
    JSON.stringify(summaries.map((s) => s.length)),
  )
  check('总结是人话（含中文）', summaries.every((s) => /[\u4e00-\u9fa5]/.test(s)))
  check(
    '最高分那条总结出了类型、范围和相关性',
    summaries[0].includes('约束类') && summaries[0].includes('本次会话范围') && summaries[0].includes('本次提问'),
    summaries[0],
  )
  check('空理由也返回一句话，不是空串', explainer.summarize({ reasons: [] }).length > 0)
  check(
    '脏入参不炸（不传 / 不是数组）',
    typeof explainer.summarize() === 'string' && explainer.summarize({ reasons: 'x' }).length > 0,
  )
}

/**
 * 老接口形态：不传 explain 必须**还是**裸 item 数组（现有调用方全靠这条）。
 *
 * @param {{ recall: object, query: string }} input
 */
export function runLegacyShapeChecks({ recall, query }) {
  group('记忆可解释 / 老接口回归')
  const bare = recall.retrieve({ query, limit: 3 })
  check(
    '★ 不传 explain 返回的还是**裸 item 数组**（不是 { item, score }）',
    Array.isArray(bare) &&
      bare.length === 3 &&
      bare.every(
        (i) =>
          typeof i.id === 'string' &&
          typeof i.content === 'string' &&
          i.item === undefined &&
          i.score === undefined &&
          i.reasons === undefined,
      ),
    JSON.stringify(bare[0] ?? null),
  )
  check(
    'explain: false 和不传一样',
    recall.retrieve({ query, limit: 3, explain: false }).every((i) => i.item === undefined),
  )
  check(
    '条数没到预算时也是裸数组（走的是短路分支）',
    (() => {
      const many = recall.retrieve({ query })
      return Array.isArray(many) && many.length > 0 && many.every((i) => i.item === undefined && i.score === undefined)
    })(),
  )
  check(
    '条数没到预算时 explain: true 也给完整的 { item, score, reasons }',
    recall
      .retrieve({ query, explain: true })
      .every((e) => e.item && typeof e.score === 'number' && Array.isArray(e.reasons)),
  )
}
