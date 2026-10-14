/**
 * 自检 / 思考（reasoning）token 采集（CE-019 · 功能 A-采集）
 *
 * 症结：用量里只有「入 / 出」，推理模型把输出的一大块花在**思考**上，单看「出」看不出来。
 * 上游其实给了 `completion_tokens_details.reasoning_tokens`，但内核**一处都没读**
 * （2026-10-15 实测：llm / budget / stats / token-metrics 四个文件里 `reasoning_tokens` 零出现）。
 * 这一组钉住「采集」这一半（UI 展示在下一轮）。
 *
 * 要钉死的事实：
 *   · **形状唯一真相源**：`budget.usageParts` 出 `{total,input,output,reasoning}`；
 *   · **老数据不炸**：老桶没 `reasoning` 键 → 补 0，**不能 undefined→NaN**；
 *   · **null vs 0 分得开**：上游没给 → null（`logLlm` 落盘），给了 0 → 0；
 *   · **不改旧语义**：total / input / output 的算法一字未动。
 */

import { check, group } from '../harness.mjs'
import { join, require, ROOT } from '../env.mjs'

export async function run() {
  const budget = require(join(ROOT, 'electron/core/budget.cjs'))
  const metrics = require(join(ROOT, 'electron/core/token-metrics.cjs'))
  const stats = require(join(ROOT, 'electron/core/stats.cjs'))

  group('CE-019 / usage 拆出 reasoning（形状唯一真相源）')

  const full = budget.usageParts({
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    completion_tokens_details: { reasoning_tokens: 30 },
  })
  check('★ 有 reasoning 就取出来', full.reasoning === 30, JSON.stringify(full))
  check('★ reasoning 是数字（不是字符串/undefined）', typeof full.reasoning === 'number')

  /* 老数据 / 没给 → 走 usageParts 一律 0（它在「拆成四个数」这一层承诺「不 NaN」） */
  const noDetails = budget.usageParts({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })
  check('★ 上游没给 reasoning_tokens → usageParts 出 0（不是 undefined）', noDetails.reasoning === 0)
  check('★ 没有 usage → 四个数都是 0（不 NaN）', (() => {
    const z = budget.usageParts(null)
    return z.total === 0 && z.input === 0 && z.output === 0 && z.reasoning === 0
  })())
  check('★ 垃圾 reasoning 值 → 0（不 NaN）', budget.usageParts({
    prompt_tokens: 1,
    completion_tokens: 1,
    completion_tokens_details: { reasoning_tokens: 'x' },
  }).reasoning === 0)

  /* ── null 与 0 必须分得开（这是「没给」和「确实是 0」的区别）── */
  group('CE-019 / null 与 0 分得开')
  check('★ 上游没给 → reasoningOf 返回 null（不是 0）', budget.reasoningOf({ completion_tokens_details: {} }) === null)
  check('★ 上游给了 0 → reasoningOf 返回 0（保留「确实是 0」）', budget.reasoningOf({ completion_tokens_details: { reasoning_tokens: 0 } }) === 0)
  check('★ 没有 usage → null', budget.reasoningOf(null) === null)

  /* ── 不改旧语义：total / input / output 算法一字未动 ── */
  group('CE-019 / 未改 total / input / output 语义')
  check('入 = prompt_tokens', budget.usageParts({ prompt_tokens: 9, completion_tokens: 1 }).input === 9)
  check('出 = completion_tokens', budget.usageParts({ prompt_tokens: 9, completion_tokens: 1 }).output === 1)
  check('★ 合计仍听上游的 total_tokens（不是入+出硬加）', budget.usageParts({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 999 }).total === 999)
  check('★ reasoning 属于输出、不是额外一桶（不参与 total 计算）', (() => {
    const p = budget.usageParts({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 7 } })
    return p.total === 20 && p.output === 10
  })())

  /* ── 落盘：token-metrics 记 reasoning，缺字段是 null ── */
  group('CE-019 / 指标落盘带 reasoning')
  check('★ logLlm 会把 reasoning 落进那一行（源码里有这个字段）', /reasoning:\s*budget\.reasoningOf/.test(
    require('node:fs').readFileSync(join(ROOT, 'electron/core/token-metrics.cjs'), 'utf8'),
  ))
  check('★ summarize 汇总里有 reasoning 与 reasoningUnavailable', (() => {
    const s = metrics.summarize({})
    return typeof s.reasoning === 'number' && typeof s.reasoningUnavailable === 'number'
  })())

  /* ── 聚合：老桶补键，不能 NaN ── */
  group('CE-019 / stats 聚合带 reasoning 且老桶不炸')
  check('★ load() 给 total 补 reasoning 键（新桶起点正确）', (() => {
    const b = stats.load().total
    return typeof b.reasoning === 'number'
  })())
  check('★ load() 对 byDay / byModel 也补键（老桶不会 undefined 一路带给界面）', (() => {
    const d = stats.load()
    const buckets = [...Object.values(d.byDay), ...Object.values(d.byModel)]
    if (buckets.length === 0) return true /* 没有历史桶时这条不适用 */
    return buckets.every((b) => typeof b.reasoning === 'number')
  })())
  check('★ addInto 里对老桶用 || 0 兜底（源码钉住，防有人改成裸 +=）', /bucket\.reasoning\s*=\s*\(Number\(bucket\.reasoning\)\s*\|\|\s*0\)/.test(
    require('node:fs').readFileSync(join(ROOT, 'electron/core/stats.cjs'), 'utf8'),
  ))
}
