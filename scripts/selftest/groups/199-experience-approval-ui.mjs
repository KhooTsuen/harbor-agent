/**
 * 自检 / 审批档位的**界面契约**（真机脚本与渲染层之间的那几根绳子）
 *
 * ── 为什么要有这一组 ──
 *
 * `tools/e2e-experience-approve.mjs` 是唯一一条真机走过审批档位的脚本（2026-11-02）。
 * 它靠四样东西在页面上找到东西：三个按钮的 `aria-label`、做法输入框的 `aria-label`、
 * 行的 `data-experience-id` / `data-experience-status`、以及「切到详细视图」那句话。
 *
 * 这四样**全在渲染层源码里**。哪天有人把「批准这条经验」改成「批准」，或者把
 * 状态钩子换个名字 —— tsc 全绿、单测全绿、构建全绿，而真机脚本会**静默失效**：
 * 它找不到按钮，只打印一行「失败」，谁也没在看。项目里已经吃过一次同款
 * （`tools/shot/cards.mjs` 那边：改文案 → 脚本照跑不误、却点不动卡）。
 *
 * 所以这里把「脚本用到的每个文案 / 钩子」逐个回到源码里找一遍 ——
 * **不是**看脚本自己写的字符串对不对，而是看**渲染层里真的还有没有**。
 *
 * ── 这一组不做什么 ──
 *
 * 不跑界面（那是 `node tools/e2e-experience-approve.mjs` 的事，要真窗口）。
 * 这里只钉「名字对得上」，跑起来能不能点，由那条 e2e 负责 —— 两者不互相顶替。
 */

import { readFileSync } from 'node:fs'

import { check, group } from '../harness.mjs'
import { ROOT, join } from '../env.mjs'

const TAB = join(ROOT, 'src/components/settings/tabs/ExperienceTab.tsx')
/*
 * 第二阶段：列表项从 `ExperienceTab.tsx` 拆到了 `ExperienceRow.tsx`
 * （那边 299 行贴顶，重排层级必须先腾地方）。按钮的 aria-label 与
 * 行的 data-* 钩子跟着搬过去了 —— 「渲染层里有这些元素」的原意不变，
 * 只是页面的渲染层现在由两个文件组成，所以这里合并后再抠。
 */
const ROW = join(ROOT, 'src/components/settings/tabs/ExperienceRow.tsx')
const E2E = join(ROOT, 'tools/e2e-experience-approve.mjs')

/**
 * 从源码里抠出所有 `aria-label="…"` / `aria-label={…}` 的字面量。
 * 只认字符串字面量 —— 拼出来的（模板串 / 变量）这里**抠不到**，
 * 而抠不到就会让下面「脚本用的每个都在」判红：这正是要的效果
 * （拼出来的文案没法被脚本稳定地找，等于契约不存在）。
 */
function labelsIn(source) {
  const out = new Set()
  for (const match of source.matchAll(/aria-label="([^"]+)"/g)) out.add(match[1])
  return out
}

export async function run() {
  const tabSrc = readFileSync(TAB, 'utf8')
  /* 列表项在 ExperienceRow.tsx —— 合并后再抠，原意是「整个页面的渲染层」 */
  const rowSrc = readFileSync(ROW, 'utf8')
  const uiSrc = `${tabSrc}\n${rowSrc}`
  const e2eSrc = readFileSync(E2E, 'utf8')
  const tabLabels = labelsIn(uiSrc)

  /* ══════════════════════════════════════════════════════════
     ① 真机脚本依赖的那几个名字，渲染层里真的还有
     ══════════════════════════════════════════════════════════ */
  group('审批档位界面 / ① 脚本依赖的文案在渲染层真的存在')

  /* 这三个是 e2e 里真正点下去的按钮（byLabel/btn 用的就是它们） */
  const ACTIONS = ['批准这条经验', '驳回这条经验', '恢复这条经验']
  for (const label of ACTIONS) {
    check(`★ 渲染层里有按钮「${label}」`, tabLabels.has(label), `ExperienceTab.tsx 里没有这个 aria-label`)
    check(`★ 真机脚本用的也是「${label}」`, e2eSrc.includes(`'${label}'`), 'e2e 脚本里找不到这个字面量')
  }
  const INPUT = '批准时使用的做法'
  check(`★ 渲染层里有输入框「${INPUT}」`, tabLabels.has(INPUT), '没找到（没有它就没法手写做法）')
  check(`★ 真机脚本用的是同一个名字`, e2eSrc.includes(INPUT), 'e2e 脚本里找不到')

  /* 抠不出来就是拼出来的 —— 那种文案脚本找不稳，明确判死 */
  check(
    '★★ 这几条都是**字面量**（不是拼出来的），脚本才能稳定找到',
    ACTIONS.every((label) => uiSrc.includes(`aria-label="${label}"`)),
  )

  /* ══════════════════════════════════════════════════════════
     ② 行钩子：脚本靠这两个属性找「哪一行」和「什么状态」
     ══════════════════════════════════════════════════════════ */
  group('审批档位界面 / ② 行的两个钩子还在')

  for (const hook of ['data-experience-id', 'data-experience-status']) {
    check(`★ 渲染层里有 ${hook}`, uiSrc.includes(hook), '没有它，脚本只能靠文案猜是哪一行')
    check(`★ 真机脚本读的是 ${hook}`, e2eSrc.includes(hook), 'e2e 脚本里找不到')
  }

  /* ══════════════════════════════════════════════════════════
     ③ 入口：默认简洁视图下收着，脚本得先切详细视图
     ══════════════════════════════════════════════════════════ */
  group('审批档位界面 / ③ 入口依赖的「切到详细视图」还在')

  /*
   * 第二阶段：这个动作从 `SettingsModal.tsx` 搬到了 `SettingsPage.tsx`
   * （设置的主入口已经是主区域工作区，弹窗只是过渡兼容）。
   * 判据跟着移到新家 —— 要守的是「渲染层里有这个动作」，不是它在哪个文件。
   */
  const pageSrc = readFileSync(join(ROOT, 'src/components/settings/SettingsPage.tsx'), 'utf8')
  check('★ 设置页里还有「切到详细视图」这个动作', /切到详细视图/.test(pageSrc), '没有它，脚本进不去审批页')
  check('★ 真机脚本找的也是这句话', /切到详细视图/.test(e2eSrc), 'e2e 脚本里找不到')
  check(
    '★ 「经验与规则」这个页还在导航表里',
    /experience/.test(uiSrc) && /经验与规则/.test(readFileSync(join(ROOT, 'src/components/settings/settingsNav.ts'), 'utf8')),
  )

  /*
   * 视图**归零**这条绳子（2026-11-02 真机第一次跑出来的）：点「去处理」会把
   * settingsView=detailed 持久化进 localStorage，第二趟打开就没有点名行了 ——
   * 所以脚本开头必须先切回简洁视图。切回的下拉在「对话」页，而那一页要真的
   * **挂着**那个组件（脚本点「对话与预览」这个不存在的名字时，整条 e2e 白跑一趟）。
   */
  const convPanel = readFileSync(join(ROOT, 'src/components/settings/panels/ConversationPanel.tsx'), 'utf8')
  const convTab = readFileSync(join(ROOT, 'src/components/settings/tabs/ConversationExperienceTab.tsx'), 'utf8')
  check(
    '★★ 视图下拉真的挂在「对话」页里（组件被 import + 渲染，不是死文件）',
    /<ConversationExperienceTab\s*\/>/.test(convPanel) && /import \{ ConversationExperienceTab \}/.test(convPanel),
    '组件没挂上，脚本就找不到「设置页视图」下拉 → 只能过第一趟',
  )
  check(
    '★ 那个下拉的 aria-label 与脚本查的一致',
    convTab.includes('aria-label="设置页视图"') && e2eSrc.includes('select[aria-label="设置页视图"]'),
    '一边改名字，另一边就静默失效',
  )
  check(
    '★★ 脚本**先归零到简洁视图**（否则同一个脚本只能跑一次）',
    /viewSel\.value!=='simple'/.test(e2eSrc) && /byText\('对话'\)/.test(e2eSrc),
    '不归零 → 第二趟 start 就是 detailed，点名行按设计不出现，全表判红',
  )

  /* ══════════════════════════════════════════════════════════
     ④ 判据读盘，不读 DOM（这条退化了，绿也是假的）
     ══════════════════════════════════════════════════════════ */
  group('审批档位界面 / ④ 真机脚本的判据看的是磁盘')

  check(
    '★★ 脚本读 experiences.json（不是只信界面上那行字）',
    /readFileSync\(\s*EXP/.test(e2eSrc) || /readFileSync\(EXP/.test(e2eSrc),
    '读不到盘 = 「已批准」只是界面自己画的',
  )
  check(
    '★ 它用的是内核的 injectable 判据，不自己再算一遍',
    /schema\.injectable\(/.test(e2eSrc),
    '自己再写一套「能不能注入」必然漂',
  )
  check(
    '★ 它走的是内核的建候选入口（不是手写 JSON 塞进库）',
    /store\.addCandidate\(/.test(e2eSrc),
    '手写 JSON 会绕过脱敏与去重那几道闸',
  )

  /*
   * 判据不许被**标签文本**骗绿（同一趟真机逮到的第二条）：那条「点名了有 N 条」的
   * 判据原本是 `/在等你处理/.test(out)`，而日志标签本身写着「在等你处理」——
   * 值明明是「（没找到）」，判据照样打勾。所以：标签里不许再出现被查的那句原话。
   */
  group('审批档位界面 / ④b 判据不会被日志标签本身骗绿')
  {
    const line = e2eSrc.split(/\r?\n/).find((l) => /say\('⓪ 点名行'/.test(l)) ?? ''
    check(
      '★★ 「点名行」那条日志的标签里不再含被查的原话',
      line !== '' && !/在等你处理/.test(line),
      line || '（找不到这条 say）',
    )
    check(
      '★★ 对应的判据查的是**值**，不是标签',
      /⓪ 点名行 → \[\^（\]/.test(e2eSrc),
      '标签带原话 → 「没找到」也会判绿',
    )
  }

  /* ══════════════════════════════════════════════════════════
     ⑤ 没有任何一条真机脚本在 tmp/ 里（那里会被清掉）
     ══════════════════════════════════════════════════════════ */
  group('审批档位界面 / ⑤ 验收脚本住在 tools/，不在 tmp/')

  check('★ 正式脚本存在', e2eSrc.length > 2000, `${E2E.length} 字节`)
  check(
    '★ 它自己铺数据、自己起应用（不依赖 tmp/ 里的临时脚本）',
    /store\.addCandidate\(/.test(e2eSrc) && /spawn\(BIN/.test(e2eSrc),
    '依赖临时脚本跑一次就断',
  )
}
