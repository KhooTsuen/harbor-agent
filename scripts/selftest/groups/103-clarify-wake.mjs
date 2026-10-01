/**
 * AG-053 批④：手动唤醒 + 「界面说的那句话，内核得认得」的形状对齐。
 *
 * 为什么单独一个文件：102-clarify-unattended 已经贴着 300 行（本项目硬约束 #2）。
 * 这一组的主题也不同 —— 102 管「静音之后怎么收场」，这里管**怎么把静音解开**。
 *
 * 这一组盯的是一类 bug（批③ 一口气出了四个）：两边各写一套约定，
 * 各自跑各自的测试都绿，接起来什么都不发生、**谁也不报错**。
 * 所以这里不查「函数写没写」，只查**拿真源码跑真行为**。
 */
import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/** 剥掉注释再扫 —— 本项目因为「注释里提到旧字段」误报过好几次 */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

export async function run() {
  const clarify = require(join(ROOT, 'electron/core/clarify.cjs'))
  const read = (p) => readFileSync(join(ROOT, p), 'utf8')

  group('AG-053 / 手动唤醒：用户说「问我」就要能问（跨模块只认一句话）')
  const session = 'selftest-clarify-wake'
  clarify.wake(session)
  clarify.noteSkip(session)
  clarify.noteSkip(session)
  check('先让它静音（连跳两次）', clarify.muted(session) === true)

  /*
   * ★ 跨模块的形状对齐：界面那个按钮写进输入框的**那句原话**，内核必须认出来。
   *   两句各写一套的话（批③ 的四个 bug 就是这么来的）——
   *   界面上点了没反应，而且**谁也不报错**。所以从源码里把那句话抠出来真跑一遍。
   */
  const toolsMenu = read('src/components/chat/composer/ToolsMenu.tsx')
  const phrase = toolsMenu.match(/const ASK_ME_PHRASE = '([^']+)'/)?.[1] ?? ''
  check('界面里定义了那句请求', phrase.length > 0, phrase)
  check('★ 内核认得界面上写的**那一句话**', clarify.looksLikeAskMe(phrase) === true, phrase)
  check(
    '★ 反过来：「别问我」这类说法不当成唤醒（否则静音形同虚设）',
    clarify.looksLikeAskMe('你看着办，别问我了') === false &&
      clarify.looksLikeAskMe('不用问了，自己拍板') === false,
  )
  check('普通请求不会被误当唤醒', clarify.looksLikeAskMe('把 README 的安装步骤改成一行脚本') === false)
  check('空消息也不炸', clarify.looksLikeAskMe('') === false && clarify.looksLikeAskMe(undefined) === false)

  /* 唤醒是**一次性**的：立刻能问，再跳两次又会静音（不写偏好） */
  clarify.wake(session)
  check('唤醒之后不静音了', clarify.muted(session) === false && clarify.skipCount(session) === 0)

  /*
   * ★ 接线：`loop-prompt` 要拿**这一份状态**去决定注不注入规则。
   *   以前它读的是 `options.clarifyMuted`，而那个字段**根本没人赋值** ——
   *   静音之后提示词里还写着「先问」，模型就去问了，工具却拒绝（两边说法不一致）。
   *   判断现在只在 `core/clarify-turn.cjs`（那边读的就是 clarify-session 的同一份状态）。
   */
  const loopPrompt = read('electron/core/loop-prompt.cjs')
  const turn = read('electron/core/clarify-turn.cjs')
  check('★ loop-prompt 把这件事交给 clarify-turn（不自己手写判断）', loopPrompt.includes('clarify-turn.cjs'))
  check('★ 那个模块读的就是工具侧同一份状态', turn.includes('session.muted(') && turn.includes('session.wake('))
  check('★ 用户说想被问 → 当场解除（用的是同一个匹配函数）', turn.includes('looksLikeAskMe'))
  check(
    '★ 不再信那个没人赋值的旧字段（读它 = 静音从来不生效）',
    /* ⚠️ 先剥注释：上面那段注释里正解释着这个旧字段，连注释一起扫会误报 */
    !codeOf(loopPrompt).includes('options.clarifyMuted') && !codeOf(turn).includes('options.clarifyMuted'),
  )
}
