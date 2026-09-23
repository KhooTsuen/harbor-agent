/**
 * 自检 / ②-5 能力边界的提前提示
 *
 * 清单里这一条原本是：
 *   ❌「UI 中超出边界提前提示 —— 没做」
 *   （README 里早就有「任务类型矩阵」，但界面上没有任何提示）
 *
 * 三条要守住的：
 *   ① **提前说，但不拦** —— 只出一条提示，消息照发、活照跑
 *   ② **模式写窄** —— 「监控面板」不能被当成「常驻监控」，误报一次就没人看这类提示了
 *   ③ **给出去路** —— 光说「不做」没用，得说「那可以怎么替代」
 */

import { check, group } from '../harness.mjs'
import { join, readFileSync, require, ROOT } from '../env.mjs'

export async function run() {
  const bounds = require(join(ROOT, 'electron/core/capability-bounds.cjs'))

  group('②-5 / 认得出碰边界的活')
  const bg = bounds.check('帮我一直盯着这个网页，一有变化就告诉我')
  check('★ 常驻后台 → 认出来', bg?.key === 'background', JSON.stringify(bg))
  check('标成「不做」', bg?.level === 'never', bg?.level)
  check(
    '★ 给出去路（不是只说一句「不做」）',
    String(bg?.note).includes('定时任务'),
    bg?.note,
  )
  check('★ 带上命中的原文（误报时用户才好判断）', String(bg?.matched).length > 0, bg?.matched)

  check('云同步 → 认出来', bounds.check('把这个同步到云上，让同事也能看到')?.key === 'cloud')
  check('跑一整天 → 认出来', bounds.check('你跑一整天好了，不用管它')?.key === 'longrun')
  check('跨仓库 → 认出来（实验性）', bounds.check('把 A 仓库的改动挪到另一个仓库')?.level === 'experimental')
  check('碰生产 → 认出来（实验性）', bounds.check('直接改线上数据库')?.key === 'prod')

  group('②-5 / 不该吵的时候一声不吭')
  check('普通请求不提示', bounds.check('把设置页的按钮对齐修一下') === null)
  check('空消息不提示', bounds.check('') === null && bounds.check(null) === null)
  check(
    '★「看看这个监控面板」不算常驻监控（模式窄一点，别误报）',
    bounds.check('帮我看看这个监控面板的代码') === null,
    JSON.stringify(bounds.check('帮我看看这个监控面板的代码')),
  )
  check(
    '★「自动跑一遍测试」不算「跑一整天」',
    bounds.check('自动跑一遍测试然后告诉我结果') === null,
  )
  check('「一直盯着日志看」才是常驻', bounds.check('一直盯着日志文件的输出')?.key === 'background')

  group('②-5 / 表本身')
  const list = bounds.list()
  check('六条边界', list.length === 6, String(list.length))
  check('每条都有「不做/实验性」的档位', list.every((x) => x.level === 'never' || x.level === 'experimental'))
  check(
    '★ 每条都写了说明（提示里要原样显示，不能只有标签）',
    list.every((x) => String(x.note).length >= 20),
    list.map((x) => x.note.length).join(','),
  )

  group('②-5 / 接线')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check('★ 发送时真的查边界', chatSrc.includes('bounds.check(lastUserText(history))'))
  check('★ 查完推给界面', chatSrc.includes("type: 'boundary'"))
  check(
    '★ 查在跑之前（别等用户等到一半才说）',
    chatSrc.indexOf('bounds.check(') < chatSrc.indexOf('const result = await loop.run({'),
  )
  /* 只提示、不拦：这一条靠「没有 return / 没有 abort」钉住 */
  check(
    '★ 只提示不拦（不 return、不抛错、不 abort）',
    !/bounds\.check\([\s\S]{0,220}?(return|abort|throw)/.test(chatSrc),
    '「碰到边界就停下」不是这里要的：判断做不做得了是用户的事',
  )

  const streamSrc = readFileSync(join(ROOT, 'src/stores/thread/streamEvents.ts'), 'utf8')
  check(
    "★ 界面转发 boundary 事件（提示类统一走 noticeEvents.ts）",
    streamSrc.includes("case 'boundary'") && streamSrc.includes('handleNoticeEvent(event)'),
  )
  const noticeSrc = readFileSync(join(ROOT, 'src/stores/thread/noticeEvents.ts'), 'utf8')
  check(
    '★ 按级别分「不做 / 实验性」两种口气（warning / info）',
    noticeSrc.includes("=== 'never' ? 'warning' : 'info'"),
  )
  check(
    '★ 提示里带上了「从哪句看出来的」',
    noticeSrc.includes('event.matched'),
    '误报时用户才好判断',
  )
}
