import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   P0（2026-11-01）：协作口径层 —— 何时开口 / 说多少 / 动手前等不等

   用户原话「我不懂编程」，而此前我读一个文件汇报一句、动他的文件前也不打招呼。
   这一层把三件事写成**恒定文本**（`core/prompt-speech.cjs`）：

     ① 动他的文件之前先用 `ask_user(gate)` 等他点一次（纯读取不拦）
     ② 只在「要他拍板」或「结果能直接用」时开口
     ③ 汇报 ≤300 字，细节挪进文件；不谈代码时不用内部代号

   ★ 为什么必须自检：提示词是**字符串**，改一个字就可能整条消失，
     tsc / lint 一个字都不会报 —— 本项目已有先例（`BROWSER_GUIDE` 的空头支票）。
   ★ 为什么还要**真跑一遍** ask_user：光看字符串在不在，挡不住
     「提示词写的调用方式，工具其实不认」——那正是空头支票的形态（硬约束 9）。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  group('P0 / 协作口径：先问再动、只在要点上开口、汇报有上限')

  const stack = require(join(ROOT, 'electron/core/prompt-stack.cjs'))
  const speech = require(join(ROOT, 'electron/core/prompt-speech.cjs'))

  /* ① 三段文案本身 */
  check(
    '★ 说了「动他的东西之前等他点一次可以」',
    /等你点一次|等他点一次|点一次「可以」/.test(speech.SPEECH_GUIDE),
  )
  check(
    '★ 说清了纯读取不用问（否则每轮都先弹卡，用户只会更烦）',
    /纯读取不用问/.test(speech.CONSENT_RULE) && /只读/.test(speech.CONSENT_RULE),
  )
  check(
    '★ 只在两种时候开口',
    /要你拍板/.test(speech.WHEN_TO_SPEAK_RULE) && /结果能直接用/.test(speech.WHEN_TO_SPEAK_RULE),
  )
  check(
    '★ 300 字上限 + 给了出口（细节挪进文件）+ 边界（代码块不算、用户要详细时不算）',
    /300 字/.test(speech.BREVITY_RULE) &&
      /挪进文件/.test(speech.BREVITY_RULE) &&
      /代码块/.test(speech.BREVITY_RULE) &&
      /详细说/.test(speech.BREVITY_RULE),
  )
  check('★ 明说不要拿内部代号当主语', /内部代号|P0/.test(speech.PLAIN_LANGUAGE_RULE))

  /* ② 真的进了系统提示（不是只产出中途产物） */
  const built = stack.build({})
  const layer = built.layers.find((item) => item.id === 'speechGuide')
  check('层装配里有一层 speechGuide', Boolean(layer) && layer.title === 'How To Talk To You')
  const text = built.message.content
  check(
    '★ 完整系统提示里带着这三条',
    /点一次/.test(text) && /300 字/.test(text) && /要你拍板/.test(text),
  )
  check(
    '★ 顺序在 workRules 之后、safety 之前',
    (() => {
      const ids = stack.ORDER
      return (
        ids.indexOf('speechGuide') > ids.indexOf('workRules') &&
        ids.indexOf('speechGuide') < ids.indexOf('safety')
      )
    })(),
  )

  /* ③ 恒定文本 → 必须在稳定区（否则每轮断缓存前缀） */
  check('★ 属于稳定区（吃前缀缓存命中）', stack.STABLE_IDS.has('speechGuide'))
  const parts = stack.splitMessages(built.layers)
  check(
    '拆成两条 system 消息时它在第一条（稳定区）里',
    parts[0].content.includes('How To Talk To You'),
  )

  /* ④ 契约：提示词里写的调用方式，工具**真的认**（硬约束 9） */
  const quoted = /ask_user\(\{\s*gate:\s*true/.test(speech.CONSENT_RULE)
  check('★ 文案里点名了 `ask_user({ gate: true })` 这个写法', quoted)
  const askUser = require(join(ROOT, 'electron/core/tools/ask_user.cjs'))
  const gateMod = require(join(ROOT, 'electron/core/tools/ask-user-gate.cjs'))
  const denied = require(join(ROOT, 'electron/core/gate-denied.cjs'))
  denied.reset()
  const reply = await askUser.run(
    { gate: true, question: '就按上面这个动手吗？' },
    {
      sessionId: 'selftest-p0-speech',
      clarify: async () => ({ approved: true, answers: [{ choice: gateMod.GATE_APPROVE_LABEL }] }),
    },
  )
  denied.reset()
  check(
    '★ 照文案那样调用 → 工具认（走的是 gate 那条路，不是普通澄清）',
    /批准/.test(reply) && !/没有批准/.test(reply),
    String(reply).slice(0, 60),
  )

  /* ⑤ 文案层与「用户当场说先别动」那条不冲突（两条并存，各管一段） */
  const rules = stack.workRules({ planFirst: true, clarifyFirst: true })
  check(
    '原有的「先别动」规矩还在（两条并存不互相挤掉）',
    /先别动/.test(rules) && /gate: true/.test(rules),
  )
}
