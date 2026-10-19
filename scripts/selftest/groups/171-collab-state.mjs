import { join, readFileSync, ROOT, require } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   协作子步骤不得污染会话状态（2026-10-20 真实 API 实机逮到的回归）

   现象：双模型跑一轮，A 规划正常、B 也调了工具，最后却报「检查完成，没有
   改动文件」，文件一个字没变。

   根因是**同一会话内的状态串味**：A 的提示词里写着「你是这次开发的规划者
   （只读角色），你没有写文件的能力」，这句经 `conversation-state.cjs` 落成
   会话 `topic`；`topic` 只在为空时写一次，于是随后执行的 B 从**同一个
   sessionId** 读回它，执行者也被告知「你没有写文件的能力」—— 只读不写。

   本组钉四件事（都不联网、不启子进程）：
     · 污染源真实存在：只读人设会被写成会话 topic
     · A 的规划 / 验收子步骤带 `collabSubStep` 标记
     · `loop-prompt.cjs` 认这个标记，且真的用它挡住 `appendState`
     · A 的正文 / 思考不往界面推（草稿不能当回答）

   「标记写了但没人读」是本项目记过的老坑（docs/踩坑记录.md 坑 #2），
   所以后两条必须查调用点，不能只查标记本身。
   ══════════════════════════════════════════════════════════════ */

const conversationState = require(join(ROOT, 'electron/core/conversation-state.cjs'))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('协作 · 子步骤不污染会话状态')

  const polluted = conversationState.update(null, [
    { role: 'user', content: '你是这次开发的规划者（只读角色）。你没有写文件的能力' },
  ])
  check(
    '★ 只读人设会被写成会话 topic（污染源真实存在）',
    /只读/.test(polluted.topic) && /没有写文件/.test(polluted.topic),
    String(polluted.topic).slice(0, 60),
  )
  check(
    '★ topic 一旦写入就不会被后面的用户话覆盖（所以 B 必然继承它）',
    conversationState.update(polluted, [{ role: 'user', content: '改成 the' }]).topic === polluted.topic,
  )

  const plannerSrc = read('electron/core/collab-planner.cjs')
  check('★ 规划 / 验收子步骤带 collabSubStep 标记', plannerSrc.includes('collabSubStep: true'))

  const promptSrc = read('electron/core/loop-prompt.cjs')
  check(
    '★ loop-prompt 认这个标记（标记写了没人读 = 没有闸门）',
    promptSrc.includes('options.collabSubStep === true'),
  )
  /* 读侧与写侧都要挡：只挡一半仍会把 A 的 topic 写进磁盘 */
  const guards = promptSrc.match(/sessionId && !subStep/g) ?? []
  check('★ 读 / 写会话状态两处都被挡住', guards.length === 2, `命中 ${guards.length} 处`)

  check(
    '★ 规划阶段的 content / reasoning 不往界面推（草稿不能当回答）',
    plannerSrc.includes("type === 'content'") && plannerSrc.includes("type === 'reasoning'"),
  )
  check(
    '★ 失败时把真实原因写回子任务台账（通知不该显示 A 的草稿）',
    plannerSrc.includes('markChildTask'),
  )
}
