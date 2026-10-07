import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   「改了代码就要有验证」提示词层（清单 2026-10-03 ❌3：自动化测试不是默认动作）

   为什么单独一组、为什么要自检：与 `110-scale-prompt` 同一个理由 —— 提示词是**字符串**，
   改一个字就可能整条消失，且 tsc / lint 一个字都不会报（本项目有过先例）。

   这一条**不跟任何开关**（它自带边界：只对「改代码」适用，末一句把闲聊/只读排除掉）——
   所以这里顺带钉住「关掉别的开关它也照样在」。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  group('提示词层：改了代码就要有验证（别逼每个任务都跑测试）')

  const stack = require(join(ROOT, 'electron/core/prompt-stack.cjs'))
  const rules = stack.workRules({ planFirst: true, clarifyFirst: true })

  check('★ 注入了「改了代码要有验证方式」', /验证方式/.test(rules), rules.includes('验证方式') ? '有' : '没有')
  check('★ 说清了「项目里没测试就先建一个最小的」', /最小的/.test(rules) && /断言/.test(rules))
  check('★ 说了「能跑测试就跑到绿再收工，别只靠读一遍」', /跑到绿/.test(rules) && /读了一遍/.test(rules))
  check(
    '★ 尺度写死：纯问答 / 只读 / 闲聊不适用（清单点名的「别把闲聊拖下水」）',
    /不适用/.test(rules) && /闲聊/.test(rules) && /只读/.test(rules),
  )
  check(
    '★ 不跟开关走：关掉 planFirst / clarifyFirst 它也照样在（否则又回到「想到了才跑测试」）',
    /验证方式/.test(stack.workRules({ planFirst: false, clarifyFirst: false })) &&
      /验证方式/.test(stack.workRules({ planFirst: true, clarifyMuted: true })),
  )
  check(
    '其余规矩没被挤掉（先看再改 / plan / 掂量代价都在）',
    /先看再改/.test(rules) && /plan 块/.test(rules) && /掂量代价/.test(rules),
  )

  /* 集成：完整装配之后它还在 —— 防「workRules 产出了、但 build 没把它拼进系统提示」
     （build 的 workRules 层由调用方传入，见 prompt-stack 的 buildLayers） */
  const full = stack.build({ planFirst: true, clarifyFirst: true, workRules: rules })
  const prompt = typeof full.message === 'string' ? full.message : JSON.stringify(full.message)
  check('★ 完整系统提示（build 的 message）里也在，不是只停在中途产物', prompt.includes('验证方式'), `系统提示长度 ${prompt.length}`)
}
