import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   A2 / 提示词层：模型先判断（从 `108-scale-gate.mjs` 拆出来的）

   为什么单独一组：108 管**闸门**（识别 / 授权 / 留痕），这一组管**注入了什么话**
   （`prompt-stack.cjs` 的 `workRules`）；2026-10-03 给 108 补完范围口径后它顶到 303 行
   （硬约束 #2 是 300），缝就按职责切在这里。

   ★ 为什么提示词层必须有自检：闸门只拦得住「已经动手了」的那一次，
     「动手前先说清范围和代价」靠的是提示词 —— 而提示词是**字符串**，
     改一个字就可能整条消失，且 tsc / lint 一个字都不会报（本项目有过先例）。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  group('A2 / 提示词层：模型先判断（闸门只兼底）')

  const stack = require(join(ROOT, 'electron/core/prompt-stack.cjs'))
  const rulesOn = stack.workRules({ planFirst: true, clarifyFirst: true })
  check(
    '★ 开着的时候注入「动手前先掂量代价」',
    /掂量代价/.test(rulesOn) && /多大范围/.test(rulesOn),
    rulesOn.includes('掂量代价') ? '有' : '没有',
  )
  check(
    '★ 文案里说清了「有界重活不用问，但要说一句」',
    /不用问/.test(rulesOn) && /预计多久/.test(rulesOn),
  )
  check(
    '★ 也说清了例外：用户说了范围 / 小范围只读探测 → 直接做',
    /已经说了范围/.test(rulesOn) && /小范围只读探测/.test(rulesOn),
  )
  check(
    '★ 和「开工前对齐」共用一个开关：关掉 clarifyFirst → 两条都不注入',
    !/掂量代价/.test(stack.workRules({ planFirst: true, clarifyFirst: false })),
  )
  check(
    '★ 静音时也不注入（不让问的时候还写着「先问规模」，模型只会来回犹豫）',
    !/掂量代价/.test(stack.workRules({ planFirst: true, clarifyMuted: true })),
  )
  check(
    '★ 拆文件没把老规矩弄丢（先看再改 / 先给计划 / 其余规矩都在）',
    /先看再改/.test(rulesOn) &&
      /plan 块/.test(rulesOn) &&
      /edit_file/.test(rulesOn) &&
      /回答用简体中文/.test(rulesOn),
    String(rulesOn.length),
  )
  check(
    '关掉 planFirst 只去掉计划那一条（其余照旧）',
    !/plan 块/.test(stack.workRules({ planFirst: false })) &&
      /掂量代价/.test(stack.workRules({ planFirst: false })),
  )

  /*
   * ★ 真机 T12 第一次跑红之后补的一条（2026-10-03）：**被闸门拦下时该干什么**。
   * 那次模型两次想扫全盘、两次被拦下，然后 —— 既不问、也不上报，直接换思路收场。
   * 「拦得住动作，拦不住不吭声」：所以提示词必须明说「被拦下就去 ask_user 问一次，
   * 别默默放弃、别换个写法重试」。
   */
  check(
    '★ 明说了「被闸门拦下要去问一次」（别默默放弃 / 别换个写法绕）',
    /拦下/.test(rulesOn) && /ask_user/.test(rulesOn) && /别换个写法/.test(rulesOn),
    rulesOn.match(/[^\n]*拦下[^\n]*/)?.[0]?.slice(0, 120) ?? '（没找到「拦下」那句）',
  )
}
