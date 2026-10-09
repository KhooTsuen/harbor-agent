/**
 * 等页面安静（settle）—— `electron/core/browse-settle.cjs`
 *
 * 2026-10-09 用户真机反馈：网络慢 / SPA 没渲染完时，读元素会拿「当时的快照」当即时结论，
 * 或者照旧索引去点、被「页面变了」拦下 —— 病根是**动手太早**。这一组钉住三件事：
 *   · settle 的判定逻辑（纯函数，直接真跑）
 *   · 三个动作（读元素 / 点 / 打字）之前都真的等过
 *   · 「没安静下来」要如实回给工具，不能当成最终状态
 */
import { createRequire } from 'node:module'
import { ROOT, join, readFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

const require = createRequire(import.meta.url)

export async function run() {
  group('浏览器 / 等页面安静（settle）')

  const settleSrc = readFileSync(join(ROOT, 'electron/core/browse-settle.cjs'), 'utf8')
  const s = require(join(ROOT, 'electron/core/browse-settle.cjs'))

  check(
    '导出：探针脚本 / 采样参数 / 判定 / 主函数',
    typeof s.PROBE_SCRIPT === 'string' &&
      typeof s.SETTLE_DEFAULTS === 'object' &&
      typeof s.stepQuiet === 'function' &&
      typeof s.settle === 'function',
  )
  check(
    '★ 顶层不 require electron（纯 Node / jsdom 能直接 require）',
    !/require\(['"]electron['"]\)/.test(settleSrc),
  )
  check(
    '探针报告 readyState / 可交互元素数 / DOM 变动计数',
    s.PROBE_SCRIPT.includes('readyState') &&
      s.PROBE_SCRIPT.includes('interactions') &&
      s.PROBE_SCRIPT.includes('mutations') &&
      s.PROBE_SCRIPT.includes('MutationObserver'),
  )

  /* ── stepQuiet：判定逻辑直接真跑（不用起 Electron） ── */
  const q = s.stepQuiet
  let st = q({ sig: null, quiet: 0 }, { readyState: 'loading', interactions: 3 }, 2)
  check('★ 还在 loading 不算安静', st.settled === false && st.quiet === 0)

  st = q({ sig: null, quiet: 0 }, { readyState: 'complete', interactions: 3 }, 2)
  check('complete 第一次采样不算安静（要连续同签名）', st.settled === false && st.quiet === 0)

  const sig1 = st.sig
  st = q({ sig: sig1, quiet: 0 }, { readyState: 'complete', interactions: 3 }, 2)
  check('★ 连续两次同签名 —— 还差一次（quietSamples=2）', st.settled === false && st.quiet === 1)

  st = q({ sig: sig1, quiet: 1 }, { readyState: 'complete', interactions: 3 }, 2)
  check('★ 连续三次同签名 → 判定安静', st.settled === true && st.quiet === 2)

  st = q({ sig: sig1, quiet: 1 }, { readyState: 'complete', interactions: 9 }, 2)
  check('★ 元素数一变就重新计数（SPA 还在填内容）', st.settled === false && st.quiet === 0)

  check(
    '采样参数在合理区间（有上限、不是无限等）',
    s.SETTLE_DEFAULTS.timeoutMs > 0 &&
      s.SETTLE_DEFAULTS.sampleMs > 0 &&
      s.SETTLE_DEFAULTS.quietSamples >= 1,
  )
  check(
    '★ settle 支持注入 evaluate（真 Chrome / 假页面能直接验，不必开 Electron）',
    settleSrc.includes('options.evaluate') && /const evaluate = options\.evaluate/.test(settleSrc),
  )

  /* ── 源码钉子：三个动作之前都真的等过 ── */
  const actSrc = readFileSync(join(ROOT, 'electron/core/browse-act.cjs'), 'utf8')
  check(
    '★ 读元素 / 点 / 打字前都先 settle（三个动作全覆盖）',
    (actSrc.match(/browseSettle\.settle\(/g) ?? []).length >= 3,
  )
  check(
    '★ 读元素为空且没安静时再给机会重读',
    actSrc.includes('isEmptySnapshot') && actSrc.includes('settled'),
  )
  check('★ settle 的结论随结果回传（不丢）', /\bsettle,/.test(actSrc))

  const elSrc = readFileSync(join(ROOT, 'electron/core/tools/browse-elements.cjs'), 'utf8')
  check(
    '★ 没安静下来要如实写进给模型看的清单（不当最终状态）',
    elSrc.includes('result.settle') && elSrc.includes('还没加载完') && elSrc.includes('没东西可点'),
  )
}
