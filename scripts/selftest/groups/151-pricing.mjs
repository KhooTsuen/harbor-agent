/**
 * 自检 / 单价配置 pricing（A-展示 · 配置层）
 *
 * 本组钉的是**配置层**的三件事（渲染层的折算另有单测）：
 *   ① 老 config.json（没有 pricing 段）读回来**自动补全**内置默认价，不报错；
 *   ② **深合并** —— 用户只填了一部分（比如只写 `out`），缺的键回落默认值，不是整段替换；
 *   ③ 形状归一 —— 单个数 / `{peak,offPeak}` 两种写法都能读，坏值兜底不炸。
 *
 * 为什么要这一组：`config-normalize.cjs` 是「改了不生效」的老坑（`image.dir` 那次）——
 * 不在白名单里的字段会被 `save()` 悄悄丢掉。pricing 是新段，必须当场钉住。
 */

import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

export async function run() {
  const C = require(join(ROOT, 'electron/core/config-defaults.cjs'))
  const normalize = require(join(ROOT, 'electron/core/config-normalize.cjs')).normalize

  group('A-展示 · pricing 默认值与归一化')

  /* ① 默认值里必须有 pricing，且是双档结构 */
  check('★ DEFAULTS 里有 pricing 段', Boolean(C.DEFAULTS.pricing))
  check(
    '★ 内置 DeepSeek 官方价（flash 未命中 高峰 2 / 空闲 1）',
    C.DEFAULTS.pricing?.providers?.deepseek?.['deepseek-flash']?.inMiss?.peak === 2 &&
      C.DEFAULTS.pricing?.providers?.deepseek?.['deepseek-flash']?.inMiss?.offPeak === 1,
  )

  /* ② 老配置（无 pricing）→ 补全默认，不报错 */
  const legacy = normalize({ version: 2, general: { theme: 'default' } })
  check('★ 老配置读回来自动补出 pricing', Boolean(legacy.pricing))
  check(
    '★ 补出来的价 = 内置默认（没丢）',
    legacy.pricing?.providers?.deepseek?.['deepseek-flash']?.out?.peak === 8,
  )

  /* ③ 深合并：只填一部份，缺的回落默认 */
  const partial = normalize({
    version: 2,
    pricing: { providers: { deepseek: { 'deepseek-flash': { out: { peak: 99, offPeak: 88 } } } } },
  })
  const flash = partial.pricing?.providers?.deepseek?.['deepseek-flash']
  check('★ 用户填的 out 生效（深合并没被默认覆盖）', flash?.out?.peak === 99 && flash?.out?.offPeak === 88)
  check('★ 用户没填的 inMiss / inHit 回落到默认值', flash?.inMiss?.peak === 2 && flash?.inHit?.peak === 0.04)

  /* ④ 单个数写法（不分档）也能读 */
  const flat = normalize({
    version: 2,
    pricing: { providers: { deepseek: { 'deepseek-flash': { out: 8, inMiss: 2, inHit: 0.04 } } } },
  })
  const flatPrice = flat.pricing?.providers?.deepseek?.['deepseek-flash']
  check(
    '★ 写单个数 → 归一成 {peak, offPeak} 同值（下游只面对一种形状）',
    flatPrice?.out?.peak === 8 && flatPrice?.out?.offPeak === 8,
  )

  /* ⑤ 坏值兜底：负数 / 字符串 / 对象里的垃圾 → 不炸 */
  const junk = normalize({
    version: 2,
    pricing: { providers: { deepseek: { 'deepseek-flash': { out: { peak: 'x', offPeak: -5 } } } } },
  })
  const junkPrice = junk.pricing?.providers?.deepseek?.['deepseek-flash']
  check(
    '★ 坏值 → 回落到默认，不产生 NaN',
    Number.isFinite(junkPrice?.out?.peak) && Number.isFinite(junkPrice?.out?.offPeak),
  )

  /* ⑥ 顶层开关的坏值兜底 */
  check('★ peakMode 只认 auto/peak/offPeak', ['auto', 'peak', 'offPeak'].includes(junk.pricing?.peakMode))
  check('★ currency 缺省是 CNY', junk.pricing?.currency === 'CNY')
}
