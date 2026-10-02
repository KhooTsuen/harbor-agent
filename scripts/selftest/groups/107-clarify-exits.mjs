import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   澄清卡上的两个「退出口」（批⑤）：「先不做了」「换个说法」

   用户原话：「'先不做了' → 任务暂停，可恢复」/「'换个说法' → AI 换个问法」。

   这一组钉三件**真跑**的事（不拿源码字符串当行为断言）：
     ① 措辞：两个出口各有一套说法，且**不能**说成「用户跳过了这次澄清」；
     ② 优先级：两个出口必须排在「跳过」前面 —— 它们回话时 `approved` 也是 false，
        上游完全可以（handler 里就是这样）连 `skipped: true` 一起给过来；
        判反了用户点了「换个说法」，模型却收到「用户跳过了」然后自己开工；
     ③ 状态：点「先不做了」**不算跳过**（跳过计数关系到静音 —— 错记一次，
        用户下次想被问就没卡了）；「换个说法」有次数上限，不会无限重问。

   ⚠️ 这一组不 require electron：`chat-confirm.cjs` 的依赖链（confirm-bridge /
      clarify-watch / log）全是纯模块，所以 `askClarify` 能**真调** ——
      手写的假对象正是批② 那次假绿的原因（假数据缺 `skipped`，一路全绿）。
   ══════════════════════════════════════════════════════════════ */

/** 造一个问题（照 99-clarify 的模板） */
const good = () => ({
  question: '用哪个包管理器？',
  options: [
    { label: 'pnpm', effect: '仓库里有 pnpm-lock.yaml，换 npm 会多装 1 份依赖' },
    { label: 'npm', effect: '要重新生成 lock 文件，多花约 30 秒' },
  ],
  defaultValue: 'pnpm',
})

export async function run() {
  const clarify = require(join(ROOT, 'electron/core/clarify.cjs'))
  const askUser = require(join(ROOT, 'electron/core/tools/ask_user.cjs'))
  const chatConfirm = require(join(ROOT, 'electron/handlers/chat-confirm.cjs'))
  const bridge = require(join(ROOT, 'electron/core/confirm-bridge.cjs'))
  const questions = clarify.normalize([good()]).questions
  const toolRun = async (ctx) => String(await askUser.run({ questions: [good()] }, ctx))

  group('AG-053 批⑤ / 措辞：两个出口各说各的，不能说成「跳过」')

  const onCancel = clarify.render(questions, { cancelled: true })
  check(
    '★「先不做了」→ 别动手 + 写清下次从哪儿接着做',
    /先不做了/.test(onCancel) && /不要再调任何工具/.test(onCancel) && /接着做/.test(onCancel),
    onCancel.slice(0, 60),
  )
  check(
    '★ 不能说成「用户跳过了」（跳过是「你接着干」，这个是「停手」）',
    !/用户跳过了这次澄清/.test(onCancel) && !/按这些答复开工/.test(onCancel),
  )
  check(
    '也不该把每条问题摊开（他要的是停，不是逐条念）',
    !/［默认］/.test(onCancel),
  )

  const onRephrase = clarify.render(questions, { rephrase: true })
  check(
    '★「换个说法」→ 重新组织问题，并明说别原样重复',
    /换个说法/.test(onRephrase) &&
      /重新组织问题再问一次/.test(onRephrase) &&
      /原样重复/.test(onRephrase),
    onRephrase.slice(0, 60),
  )
  check(
    '★ 不能也说成「跳过了」——说错了用户还在等一张重新问的卡，而模型已经自己开工了',
    !/用户跳过了这次澄清/.test(onRephrase),
  )

  group('AG-053 批⑤ / 优先级：两个出口必须排在「跳过」前面')

  /* ★ 这两个断言是本组存在的理由：真机形状里 skipped 和出口标记是**同时**来的 */
  check(
    '★「先不做了」带 skipped=true 时，仍然是「先不做了」（判反就是批② 那个坑的翻版）',
    /先不做了/.test(clarify.render(questions, { skipped: true, cancelled: true })),
  )
  check(
    '★「换个说法」带 skipped=true 时，仍然是「换个说法」',
    /重新组织问题再问一次/.test(clarify.render(questions, { skipped: true, rephrase: true })),
  )
  check(
    '纯跳过（老形状）一个字段都不差 —— 加了出口不能把老路改松',
    /用户跳过了这次澄清/.test(clarify.render(questions, { skipped: true })),
  )

  group('AG-053 批⑤ / 真调 askClarify：回话里的标记要被解出来')

  /** 走一遍真往返：发出去 → 按渲染层那个形状回话（approved=false）→ 看内核收到什么 */
  const roundTrip = async (wire) => {
    bridge.reset()
    const events = []
    const pending = chatConfirm.askClarify({
      sessionId: 'selftest-exit-wire',
      taskId: 'task_exit',
      questions: [good()],
      emit: (event) => events.push(event),
    })
    /* 渲染层的两个出口都是 approved=false（回话里才有标记） */
    bridge.settle(events[0].confirmId, false, wire)
    return pending
  }

  const gotCancel = await roundTrip(JSON.stringify({ skipped: true, cancelled: true, answers: [] }))
  check(
    '★「先不做了」的回话被解成 cancelled',
    gotCancel.cancelled === true && gotCancel.skipped === true && gotCancel.timeout === false,
    JSON.stringify(gotCancel),
  )
  const gotRephrase = await roundTrip(JSON.stringify({ skipped: true, rephrase: true, answers: [] }))
  check('★「换个说法」的回话被解成 rephrase', gotRephrase.rephrase === true, JSON.stringify(gotRephrase))
  check(
    '★ 老形状（只有 skipped、没有标记）行为不变：就是一次跳过',
    (await roundTrip(JSON.stringify({ skipped: true, answers: [] }))).cancelled === undefined,
  )
  check(
    '坏 JSON（老界面/手滑）仍然当跳过 —— 不能把任务卡住',
    (await roundTrip('{不是一个 JSON')).skipped === true,
  )
  check(
    '★ 真调之后没有留下悬着的请求（否则主进程里挂一条永远没人回话的待办）',
    bridge.pendingCount() === 0,
    String(bridge.pendingCount()),
  )

  group('AG-053 批⑤ / 工具：「先不做了」不算跳过、不静音')

  const sessionCancel = 'selftest-exit-cancel'
  clarify.wake(sessionCancel)
  const cancelText = await toolRun({
    sessionId: sessionCancel,
    clarify: async () => ({ answers: [], skipped: true, timeout: false, cancelled: true }),
  })
  check(
    '★ 工具把「先不做了」翻成人话（模型据此停手并写交接）',
    /先不做了/.test(cancelText) && /不要再调任何工具/.test(cancelText),
    cancelText.slice(0, 50),
  )
  check(
    '★★ 点「先不做了」**不算跳过**（否则连点两次下一次想被问都没卡了）',
    clarify.skipCount(sessionCancel) === 0 && clarify.muted(sessionCancel) === false,
    `skip=${clarify.skipCount(sessionCancel)} muted=${clarify.muted(sessionCancel)}`,
  )

  group('AG-053 批⑤ / 工具：「换个说法」有次数上限')

  const sessionRephrase = 'selftest-exit-rephrase'
  clarify.wake(sessionRephrase)
  const rephraseTransport = async () => ({
    answers: [],
    skipped: true,
    timeout: false,
    rephrase: true,
  })
  const first = await toolRun({ sessionId: sessionRephrase, clarify: rephraseTransport })
  check(
    '★ 第一次「换个说法」→ 要求重新组织问题',
    /重新组织问题再问一次/.test(first),
    first.slice(0, 50),
  )
  check('重问计数记下来了（排查用）', clarify.rephraseCount(sessionRephrase) === 1)
  check(
    '★ 重问也不算跳过（他只是说没问清，不是让你别问）',
    clarify.skipCount(sessionRephrase) === 0 && clarify.muted(sessionRephrase) === false,
  )

  await toolRun({ sessionId: sessionRephrase, clarify: rephraseTransport })
  const third = await toolRun({ sessionId: sessionRephrase, clarify: rephraseTransport })
  check(
    `★ 超过上限（${clarify.REPHRASE_LIMIT} 次）就不再问了，改成自己拍板并说明理由`,
    /已经用过 2 次/.test(third) && /自己判断最稳妥的做法/.test(third),
    third.slice(0, 60),
  )
  check('上限那次**不再**出现「重新组织问题」（不能一边说别问了、一边还在问）', !/重新组织问题/.test(third))
  clarify.noteAnswered(sessionRephrase)
  check('★ 答过一次 → 重问计数清零（下一张卡是新话题，从头开始）', clarify.rephraseCount(sessionRephrase) === 0)
}
