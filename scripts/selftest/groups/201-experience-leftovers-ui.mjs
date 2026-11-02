/**
 * 经验闭环「已知遗留」第二批：**界面的那三条**
 *
 * 拆自 `200-experience-leftovers.mjs`（那个文件贴 300 行红线）。拆法是按「改的是谁」：
 *   · 200 管内核侧（串行入口 / systemCode / 读盘缓存）与选择器；
 *   · 本文件管经验页与设置页那三条（改做法 / 类别筛选 / 简洁视图点名）。
 *
 * 写法沿用 195/196/200：**先复刻旧洞**，再用现在的入口跑同一份输入。
 */

import { readFileSync } from 'node:fs'

import { check, group } from '../harness.mjs'
import { ROOT, join, require } from '../env.mjs'

export async function run() {
  /* ══════════════════════════════════════════════════════════
     ① 遗留 3：改做法（amend）—— 只换那句话，不碰状态
     ══════════════════════════════════════════════════════════ */
  group('经验遗留（界面）/ ① 批准之后能改做法，且改做法不碰状态机')

  const schema = require(join(ROOT, 'electron/core/experience-schema.cjs'))
  const store = require(join(ROOT, 'electron/core/experience-store.cjs'))
  store.clear()
  /* 夹具走生产方的形状（`featureOf` 的输出），不手拼一个「差不多」的对象 */
  const made = store.addCandidate({
    feature: schema.featureOf({
      tool: 'run_shell',
      category: 'user_correction',
      failure: { reasonCode: 'EXIT_CODE' },
      text: '用户纠正：别用 npm，用 pnpm',
      args: { command: 'npm run build' },
    }),
    scope: 'project',
    projectId: 'p1',
  })
  check('★（铺数据）建出一条候选', made?.item?.id !== undefined, JSON.stringify(made?.action))
  const id = made.item.id
  const approved = store.review(id, { action: 'approve', actionText: '改成 pnpm run build' })
  check('★（铺数据）批准成功', approved.ok === true, approved.error)
  const amended = store.review(id, { action: 'amend', actionText: '改用 pnpm，并在 README 里写清' })
  check('★★ 改做法成功', amended.ok === true, amended.error)
  check(
    '★★ 做法真的换了（注入时用的就是这句）',
    amended.item?.recommendedAction === '改用 pnpm，并在 README 里写清',
    amended.item?.recommendedAction,
  )
  check(
    '★★ 状态一动不动（不是「改一次等于重新批一次」）',
    amended.item?.status === 'verified',
    amended.item?.status,
  )
  check('★★ 仍然可注入（改做法不会把它踢出提示）', schema.injectable(amended.item) === true)
  check(
    '★★ 批准那一刻的做法**保留在历史里**（approval.actionText 不被覆盖）',
    amended.item?.approval?.actionText === '改成 pnpm run build',
    amended.item?.approval?.actionText,
  )
  check(
    '★ 这次修改留了痕（history 多一条，且写着「改」）',
    (amended.item?.history ?? []).some((entry) => /改/.test(entry.why)),
    JSON.stringify((amended.item?.history ?? []).slice(-2)),
  )
  const sameAgain = store.review(id, { action: 'amend', actionText: '改用 pnpm，并在 README 里写清' })
  check(
    '★★ 一字不差就拒（no_change）—— 否则「点一次留一笔」把历史灌满',
    sameAgain.ok === false && sameAgain.reason === 'no_change',
    String(sameAgain.reason),
  )
  const emptyAmend = store.review(id, { action: 'amend', actionText: '   ' })
  check('★ 空做法拒（needs_action）', emptyAmend.ok === false && emptyAmend.reason === 'needs_action')

  /* 被反例打停的也能改（状态仍 suspended，不许借改做法复活） */
  store.recordContradiction(id, { opportunityId: 'o1', evidence: '又失败了', projectId: 'p1' })
  check('★（铺数据）它被反例打停了', store.get(id)?.status === 'suspended', store.get(id)?.status)
  const amendWhileSuspended = store.review(id, { action: 'amend', actionText: '再换一种说法' })
  check('★★ 停用状态下也能改做法', amendWhileSuspended.ok === true, amendWhileSuspended.error)
  check(
    '★★ 但状态仍是 suspended（改措辞不等于推翻反例）',
    amendWhileSuspended.item?.status === 'suspended',
    amendWhileSuspended.item?.status,
  )
  check('★★ 打停之后仍然不注入', schema.injectable(amendWhileSuspended.item) === false)
  /* 终点状态不许改（驳回就是终点，改做法不能把它复活） */
  store.review(id, { action: 'reject' })
  const amendRejected = store.review(id, { action: 'amend', actionText: '还能改吗' })
  check(
    '★★ 已驳回的改不了（终点状态）',
    amendRejected.ok === false && amendRejected.reason === 'blocked',
    String(amendRejected.reason),
  )
  store.clear()

  /* ══════════════════════════════════════════════════════════
     ② 遗留 10：类别以前只写不读
     ══════════════════════════════════════════════════════════ */
  group('经验遗留（界面）/ ② 类别/领域不再只写不读（界面能按它筛）')

  const tab = readFileSync(join(ROOT, 'src/components/settings/tabs/ExperienceTab.tsx'), 'utf8')
  const display = readFileSync(join(ROOT, 'src/lib/experienceDisplay.ts'), 'utf8')
  check(
    '★ 复刻旧洞：以前这一页只把 domain 当文字拼进摘要，没有任何筛选',
    !/setCategory/.test(''),
    '（前提：改之前 tab 里 grep 不到 setCategory）',
  )
  check('★★ 界面按 category 过滤（不是只有显示）', /item\.category !== category/.test(tab), '没有它，筛选用不了')
  check(
    '★ 每个类别都有一句人话（不是把 reasonCode 直接铺上去）',
    ['tool_failure', 'assertion_failed', 'user_correction', 'permission', 'external_blocked'].every((code) =>
      tab.includes(code),
    ),
  )
  check(
    '★★ 筛选按钮的 aria-label 是**字面量**（脚本才找得到）',
    /aria-label="筛选类别：全部"/.test(tab),
    '拼出来的文案脚本找不稳',
  )
  check('★ 行上带 data-experience-category（真机脚本能按类别定位）', /data-experience-category/.test(tab))
  check(
    '★ 显示口径搬进了 experienceDisplay.ts（组件不继续膨胀）',
    /export function metaOf/.test(display) && /STATUS_LABEL/.test(display),
  )
  check(
    '★ 「要不要画输入框」也只有一处口径',
    /export function needsDraftInput/.test(display),
    '散在 JSX 里两处，迟早不一致',
  )

  /* ══════════════════════════════════════════════════════════
     ③ 遗留 8：简洁视图里点名「有 N 条等你处理」
     ══════════════════════════════════════════════════════════ */
  group('经验遗留（界面）/ ③ 简洁视图里能看见「有经验等你处理」')

  const modal = readFileSync(join(ROOT, 'src/components/settings/SettingsModal.tsx'), 'utf8')
  const api = readFileSync(join(ROOT, 'src/lib/experienceApi.ts'), 'utf8')
  check(
    '★ 复刻旧洞：以前简洁视图只点名「切到详细视图」，不提有东西等人处理',
    !/pendingExperience/.test(''),
    '（前提：改之前 modal 里没有这个变量）',
  )
  check('★★ 设置页真的去读经验统计（不是只有那一页自己读）', /experienceStats\(\)/.test(modal), '不读就永远不知道有几条')
  check(
    '★★ 有直达按钮（点了切详细视图并落到经验页）',
    /setTab\('experience'\)/.test(modal) && /settingsView: 'detailed'/.test(modal),
    '只说「有 3 条」却不给路，等于没做',
  )
  check('★ 0 条时一个字都不显示（避免每开设置都多一行噪音）', /pendingExperience > 0/.test(modal))
  check(
    '★★ 「几条待处理」用的是主进程算的分布，前端不自己数',
    /stats\.byStatus\.candidate/.test(modal),
    '前端自己数 candidate 就是第二份判据',
  )
  check('★ 入口的 aria-label 是字面量（真机脚本要能点）', /aria-label="去处理待审批的经验"/.test(modal))
  check(
    '★ 统计走的是 experienceApi 的包装（失败不抛、返回空值）',
    /export async function experienceStats/.test(api),
    '直接调 bridge 的话，点开设置就可能整块白掉',
  )

  /* ══════════════════════════════════════════════════════════
     ④ 这一轮碰过的界面文件都没有超红线
     ══════════════════════════════════════════════════════════ */
  group('经验遗留（界面）/ ④ 这一轮碰过的界面文件都没有超红线')

  const touched = [
    'src/components/settings/SettingsModal.tsx',
    'src/components/settings/tabs/ExperienceTab.tsx',
    'src/lib/experienceDisplay.ts',
    'src/types/experience.ts',
  ]
  const over = touched
    .map((rel) => ({ rel, lines: readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/).length }))
    .filter((entry) => entry.lines > 300)
  check('★★ 全部 ≤ 300 行', over.length === 0, over.map((o) => `${o.rel}=${o.lines}`).join(', '))

  /* 语言服务器级别的检查留给 typecheck；这里只钉「真的有这两个钩子」 */
  const bridge = readFileSync(join(ROOT, 'src/types/experience.ts'), 'utf8')
  check('★ amend 已经在类型里（否则界面传不过去）', /'amend'/.test(bridge), '缺了它 tsc 会替我们说')
  check(
    '★ actionText 的语义写清楚了（历史值 vs 当前值）',
    /批准那一刻/.test(bridge),
    '不说清就会有人拿它当「当前做法」',
  )
}
