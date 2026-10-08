import { check, group } from '../harness.mjs'
import { ROOT, join, readFileSync, require } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   浏览器：换历史（后退 / 前进）搬到主进程经 CDP（B4，2026-10-09）

   从渲染层 `navStep.ts` 搬来（那个文件已删）。这一组钉两件事：

   · **纯逻辑**（`targetEntryId` / `navBlockedText`）—— 不用开 Electron
     就能直接跑，正好把「挑上/下一条」和「换不了页的那句诊断话」锁住。
   · **源码级守卫** —— 那几条线违反时的表现都是**静默**的：
     少一条兜底、「到头了」的诊断值漂了，都不会当场报错，只会让模型
     以为路到头了。所以放在这儿守着。

   ★ 2026-10-06 真机 bug 的教训（别弄丢）：不许拿「能不能后退」的自报
     当结论 —— 页面自报有上一页、而 `canGoBack()` 回 false，于是把一条
     能成的路说成「到头了」。现在是「动手 + 核实」。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  group('浏览器 / browse-history 纯逻辑')

  const hist = require(join(ROOT, 'electron/core/browse-history.cjs'))

  const two = {
    index: 0,
    entries: [{ id: 5 }, { id: 7 }],
    back: false,
    forward: true,
  }
  check('★ back：从第 0 格挑「上一条」→ 没有（null，走兜底）', hist.targetEntryId(two, 'back') === null)
  check(
    '★ back：从第 1 格挑「上一条」→ 拿到那一条的 id',
    hist.targetEntryId({ ...two, index: 1 }, 'back') === 5,
  )
  check('★ forward：从第 0 格挑「下一条」→ 拿到那一条的 id', hist.targetEntryId(two, 'forward') === 7)
  check(
    '★ forward：已经是最后一格 → 没有（null）',
    hist.targetEntryId({ ...two, index: 1 }, 'forward') === null,
  )
  check('★ 空历史也安全（挑不出东西，不炸）', hist.targetEntryId({ index: 0, entries: [] }, 'back') === null)

  const blocked = hist.navBlockedText(
    'back',
    { back: false, forward: false, before: 'https://a.example/' },
    'https://a.example/',
  )
  check('★ 「换不了页」的话点名是上一页还是下一页', blocked.includes('上一页'))
  check('★ 带上 canGoBack 诊断值（模型据此定性）', blocked.includes('canGoBack=false'))
  check('★ 带上当前地址（诊断现场）', blocked.includes('https://a.example/'))
  check(
    '★ 两种方向说的话不一样（别把 back 的话发给 forward）',
    hist.navBlockedText('forward', { back: true, forward: true, before: '' }, '').includes('下一页'),
  )

  group('浏览器 / browse-history 源码守卫')

  const src = readFileSync(join(ROOT, 'electron/core/browse-history.cjs'), 'utf8')
  check('★ 顶层不 require electron（纯 Node 自检能直接 import）', !/require\(['"]electron['"]\)/.test(src))
  check(
    '★ 正路用 CDP 的历史（DevTools 那份，比 canGoBack 可靠）',
    /Page\.getNavigationHistory/.test(src) && /Page\.navigateToHistoryEntry/.test(src),
  )
  check('★ 兜底会用页面自己的 history.back / forward', /history\.\$\{step\}\(\)/.test(src))
  check('★ 动手之后核实（轮询地址真的变了没有）', /waitForMove\(webContentsId, before/.test(src))
  check('★ 失败信息里带上 canGoBack / canGoForward 诊断值', /canGoBack=\$\{outcome\.back\}/.test(src))

  /* 迁移的收尾：渲染层那套（navStep / waitForNavMove）不许留残影 */
  const driverSrc = readFileSync(
    join(ROOT, 'src/components/layout/browser/useBrowseDriver.ts'),
    'utf8',
  )
  check('★ 驱动层不再 import 已删的 navStep', !/from '\.\/navStep'/.test(driverSrc))
  let navStepGone = false
  try {
    readFileSync(join(ROOT, 'src/components/layout/browser/navStep.ts'), 'utf8')
  } catch {
    navStepGone = true
  }
  check('★ 渲染层的 navStep.ts 已删（逻辑去了主进程）', navStepGone)
}
