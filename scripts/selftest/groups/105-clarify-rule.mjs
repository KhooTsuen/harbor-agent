import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-053：澄清规则的**注入与开关**（从 `99-clarify.mjs` 分出来的）

   为什么分：99 加完「三条触发条件 + 要问必须走工具」两条断言后到了 312 行
   （硬约束 #2 = 300）。分口子按「管什么」切：99 管**内核侧行为**
   （校验 / 静音 / render / 工具注册），这里只管**提示词那一段**。

   ⚠️ 2026-10-02 真机验收逮到的两种「没问」，都发生在这一段还没写硬的时候：
     ① 探索两步就自己定了改法（需求含糊，但模型没意识到该问）；
     ② **把问题写在回复正文里**，根本没调 `ask_user` —— 界面不会弹卡、
        用户也没法按选项回答，等于没问。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const promptStack = require(join(ROOT, 'electron/core/prompt-stack.cjs'))

  group('AG-053 / 规则注入与开关')
  const rules = promptStack.workRules({ planFirst: true, clarifyFirst: true })
  check('★ 开着时提示词里有「开工前先对齐」', rules.includes('ask_user') && rules.includes('开工前先对齐'))
  check('★ 规则里硬要求 effect 带具体数字或事实', /具体数字或事实/.test(rules))
  check('★ 规则里硬要求默认选项是最保守那个', /最容易回滚/.test(rules))
  check('规则里写明「你看着办」就不问', /看着办/.test(rules))
  check(
    '★ 规则列全了三条「该问」的触发条件（改法不止一种 / 不好回退 / 范围没说清）',
    /改法不止一种/.test(rules) && /不好回退/.test(rules) && /范围没说清/.test(rules),
  )
  check(
    '★ 规则要求「要问就调 `ask_user`」，并声明写在正文里不算',
    /必须调 `ask_user`/.test(rules) && /正文/.test(rules),
  )
  check(
    '关掉开关 → 这一条不注入（其余照旧）',
    !promptStack.workRules({ planFirst: true, clarifyFirst: false }).includes('ask_user'),
  )
  check(
    '静音时也不注入（提示词里写着「先问」却不让问，模型会来回犹豫）',
    !promptStack.workRules({ planFirst: true, clarifyMuted: true }).includes('ask_user'),
  )
  check('计划那一条不受这个开关影响', rules.includes('plan 块'))
}
