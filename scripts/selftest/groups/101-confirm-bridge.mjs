import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-053：确认往返（`core/confirm-bridge.cjs`）—— 老路径与澄清**行为隔离**

   这条通道原来只回一个布尔（写操作确认/审批），这一轮加了一个**可选**的答复
   （澄清卡把用户的选择带回来）。最危险的不是新功能不work，而是**改坏老路径**：
   审批那侧要的仍然是「`approved === true` 才算同意」，多一个参数不能让它变松。

   所以这一组钉的就是「两条路互不影响」：
     ① 不传 answer → 老路径拿到的还是布尔，且**只有 true 才算同意**；
     ② 传 answer → 澄清那侧能拿到答复原文；
     ③ 超时：老路径 false（算拒绝），新路径要能区分 `timeout`（离场了，不是拒绝）；
     ④ 过期/重复回话 → 明确报错，不静默。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const bridge = require(join(ROOT, 'electron/core/confirm-bridge.cjs'))
  const askUser = require(join(ROOT, 'electron/core/tools/ask_user.cjs'))
  /*
   * ⚠️ 下面几个「源码里应该写着 require('…')」的针必须**拼出来**，不能写成连续字符串：
   *   12-requires 那组会扫 `.mjs` 里的 `require('…')` 字面量、按**本文件所在目录**
   *   解析路径 —— 针是字符串不是真引用，写成连续字符串就会被误报成
   *   「相对 require 指向不存在的文件」。拼出来断言强度一点不减。
   */
  const reqOf = (spec) => ["require('", spec, "')"].join('')

  group('AG-053 / 往返：老路径（审批）不带答复时行为不变')
  bridge.reset()
  const asked = []
  const pending = bridge.ask({
    timeoutMs: 5000,
    payload: { type: 'confirm_request', kind: 'write', toolName: 'write_file' },
    emitReply: (payload) => asked.push(payload),
  })
  check('请求已经发给渲染层（带 confirmId）', asked.length === 1 && Boolean(asked[0].confirmId))
  check('老的字段都在（kind / toolName 原样带出去）', asked[0].kind === 'write' && asked[0].toolName === 'write_file')
  const settled = bridge.settle(asked[0].confirmId, true)
  check('回话成功', settled.ok === true)
  const reply = await pending
  check('★ 不带 answer 时拿到的还是老形状（approved: true）', reply.approved === true, JSON.stringify(reply))
  check('answer 是空串而不是 undefined（老调用方不必判空）', reply.answer === '')
  check('不是超时', reply.timeout === false)
  check('回话之后不再挂着（不会重复结算）', bridge.pendingCount() === 0)

  group('AG-053 / 往返：只有明确的 true 才算同意（不能变松）')
  for (const [label, value] of [
    ['false', false],
    ['undefined', undefined],
    ['null', null],
    ['0', 0],
    ['字符串 yes', 'yes'],
    ['对象 {ok:false}', { ok: false }],
  ]) {
    bridge.reset()
    const seen = []
    const promise = bridge.ask({ timeoutMs: 5000, emitReply: (p) => seen.push(p) })
    bridge.settle(seen[0].confirmId, value)
    const got = await promise
    check(`传 ${label} → 不算同意`, got.approved === false, JSON.stringify(got))
  }

  group('AG-053 / 往返：澄清带上答复（同一通道，回话形状不同）')
  bridge.reset()
  const askedClarify = []
  const clarifyPromise = bridge.ask({
    timeoutMs: 5000,
    idPrefix: 'clr',
    payload: { type: 'confirm_request', kind: 'clarify', questions: [{ question: '用哪个？' }] },
    emitReply: (payload) => askedClarify.push(payload),
  })
  check('澄清的 confirmId 带自己的前缀（排查日志时一眼分得开）', String(askedClarify[0].confirmId).startsWith('clr_'), askedClarify[0].confirmId)
  check('问题上原样带出去（渲染层要照着画）', Array.isArray(askedClarify[0].questions))
  const wire = JSON.stringify({ skipped: false, answers: [{ question: '用哪个？', choice: 'pnpm', text: '习惯了' }] })
  bridge.settle(askedClarify[0].confirmId, true, wire)
  const got = await clarifyPromise
  check('★ 答复原文能拿到（澄清那侧要解析它）', got.answer === wire)
  check('approved 也带上了（跳过的判定要用）', got.approved === true)
  check(
    '★ 同一条通道：审批前缀 cfm / 澄清前缀 clr，形状互不干扰',
    asked[0].confirmId.startsWith('cfm_') && askedClarify[0].confirmId.startsWith('clr_'),
  )

  group('AG-053 / 往返：超时 —— 老路径算拒绝，新路径要能区分「离场」')
  bridge.reset()
  const timeoutAsk = bridge.ask({ timeoutMs: 10, emitReply: () => {} })
  const timedOut = await timeoutAsk
  check('★ 超时时 timeout=true（澄清据此走「按默认选项继续」）', timedOut.timeout === true, JSON.stringify(timedOut))
  check('★ 超时时 approved=false（老路径拿到的仍然是 false，和以前一样）', timedOut.approved === false)
  check('超时后不留在表里', bridge.pendingCount() === 0)

  group('AG-053 / 往返：过期与重复回话都要说清楚')
  bridge.reset()
  check('没这个 id → 明确报错', bridge.settle('cfm_不存在', true).ok === false)
  const seen2 = []
  const once = bridge.ask({ timeoutMs: 5000, emitReply: (p) => seen2.push(p) })
  bridge.settle(seen2[0].confirmId, true)
  await once
  check('同一个 id 回第二次 → 报「已经过期」（不静默成功）', bridge.settle(seen2[0].confirmId, true).ok === false)

  group('AG-053 / 接线：通道复用 + 三条链路上的参数都对')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat-confirm.cjs'), 'utf8')
  check(
    '★ 没有开新通道：答复还是走 chat:confirm',
    chatSrc.includes("ipcMain.handle('chat:confirm'") &&
      !chatSrc.includes("ipcMain.handle('chat:clarify'"),
  )
  check(
    '★ handler 把第三个参数透下去（不透 = 澄清永远拿不到答复）',
    /settle\(\s*confirmId,\s*approved,\s*answer\s*\)/.test(chatSrc),
  )
  check(
    '老路径只取布尔（`.then((reply) => reply.approved === true)`）',
    chatSrc.includes('reply.approved === true'),
  )
  check('澄清往返真的转出去了（askClarify 是模块出口）', chatSrc.includes('askClarify,'))
  check(
    '★ 两条往返拆在 handlers/chat-confirm.cjs（chat.cjs 贴着 300 行，塞不进去）',
    readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8').includes(reqOf('./chat-confirm.cjs')),
  )
  const preload = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  check(
    '★ preload 把可选答复传下去（同行改，净 0 行）',
    preload.includes("confirmChat: (confirmId, approved, answer) => call('chat:confirm', confirmId, approved, answer)"),
  )
  const backend = readFileSync(join(ROOT, 'src/lib/backend.ts'), 'utf8')
  check('桥包装带上可选参数（并且仍是可选 —— 老调用方一字不用改）', backend.includes('answer?: string'))
  const confirmEvents = readFileSync(join(ROOT, 'src/stores/thread/confirmEvents.ts'), 'utf8')
  check('渲染层分流：kind=clarify 走澄清卡', confirmEvents.includes("kind === 'clarify'"))
  check('答完把答复原文发回去（JSON 字符串）', confirmEvents.includes('clarifyReplyToWire(reply)'))
  check(
    '★ 卡片被外部关掉也算回话（不回主进程要干等 5 分钟超时）',
    /onCancel: \(\) => void confirmChat\(confirmId, false\)/.test(confirmEvents),
  )
  const toolSrc = readFileSync(join(ROOT, 'electron/core/tools/ask_user.cjs'), 'utf8')
  check(
    '工具侧惰性 require handler（照 browse.cjs 的写法，不碰 loop.cjs）',
    toolSrc.includes(reqOf('../../handlers/chat-confirm.cjs')),
  )
  check(
    '★ ctx.clarify === null 是「显式关掉」的开关（自检/探针要验 fail-open）',
    toolSrc.includes('ctx.clarify === null'),
  )

  group('AG-053 / 接线：澄清事件必须走对话 emitter（少了 requestId 就静默丢卡）')
  /*
   * ★ 这组要的是**行为**断言，源码断言钉不住它：
   *   批② 第一版写的是 `emitReply: (payload) => send(payload)`，而 `send` 的签名是
   *   `(channel, payload)` —— 每个词都在源码里，跑起来却一条事件都到不了渲染层：
   *   少了 `chat:event` 频道，也少了**对话的 requestId**（只有 emitter 会补），
   *   渲染层按 requestId 过滤（`turns.ts`：不匹配就 return）直接丢掉。
   *   真机上的表现是：模型调了 ask_user、界面一片安静，最后自己拍板了事。
   */
  const chatConfirm = require(join(ROOT, 'electron/handlers/chat-confirm.cjs'))
  bridge.reset()
  const wireEvents = []
  const clarifyAgain = chatConfirm.askClarify({
    sessionId: 'selftest-clarify-emit',
    taskId: 'task_x',
    questions: [{ question: '用哪个？', options: [{ label: 'a', effect: '多花 30 秒' }] }],
    emit: (event) => wireEvents.push(event),
  })
  check(
    '★ 澄清请求发出去了，且形状能直接被渲染层认出来（confirm_request + kind=clarify）',
    wireEvents.length === 1 &&
      wireEvents[0].type === 'confirm_request' &&
      wireEvents[0].kind === 'clarify' &&
      String(wireEvents[0].confirmId).startsWith('clr_'),
    JSON.stringify(wireEvents[0] ?? null).slice(0, 90),
  )
  bridge.settle(wireEvents[0].confirmId, true, JSON.stringify({ answers: [{ question: '用哪个？', choice: 'a' }] }))
  const clarifyGot = await clarifyAgain
  check('回话能解成答复', clarifyGot.answers?.[0]?.choice === 'a', JSON.stringify(clarifyGot))

  bridge.reset()
  const noChannel = await chatConfirm.askClarify({
    questions: [{ question: 'x', options: [{ label: 'a', effect: '多花 1 秒' }] }],
  })
  check(
    '★ 拿不到事件通道 → 立刻报 noWindow（不让任务干等 5 分钟）',
    noChannel.noWindow === true && noChannel.skipped === true && noChannel.timeout === false,
    JSON.stringify(noChannel),
  )
  check('★ 没通道时**不挂请求**（否则留一条永远没人回话的待办）', bridge.pendingCount() === 0)

  /*
   * ★ 超时要跑**真形状**（不是手写的假对象）：`timeoutMs` 就是为了这个存在的
   *   —— 否则自检得干等 5 分钟。批② 真机抓到的 bug 是：超时回的是
   *   `{ skipped: true, timeout: true, answers: [] }`，而 `render()` 先判 skipped，
   *   于是离场被当成「用户说跳过」，［默认］标记永远不出现。
   *   自检当时的假数据没带 skipped，所以一路绿。
   */
  bridge.reset()
  const realTimeout = await chatConfirm.askClarify({
    questions: [{ question: '用哪个？', options: [{ label: 'a', effect: '多花 30 秒' }] }],
    emit: () => {},
    timeoutMs: 10,
  })
  check(
    '★ 超时的真实形状：skipped 与 timeout 同时为真、answers 为空',
    realTimeout.timeout === true &&
      realTimeout.skipped === true &&
      Array.isArray(realTimeout.answers) &&
      realTimeout.answers.length === 0,
    JSON.stringify(realTimeout),
  )
  const core = require(join(ROOT, 'electron/core/clarify.cjs'))
  const rendered = core.render(
    core.normalize([{ question: '用哪个？', options: [{ label: 'a', effect: '多花 30 秒' }] }]).questions,
    realTimeout,
  )
  check(
    '★ 那个形状能被 render 翻成人话（离场 + ［默认］，不能是「用户说跳过」）',
    /离场/.test(rendered) && /［默认］/.test(rendered) && !/用户跳过了这次澄清/.test(rendered),
    rendered.slice(0, 80),
  )
  check(
    '★ chat.cjs 不再往 chat-confirm 传裸 send（那个 send 少一个频道参数，就是上面那个 bug）',
    !readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8').includes(
      'chatConfirm.register({ ipcMain, send })',
    ),
  )
  /*
   * ★ 残留引用：批② 把确认表搬到 confirm-bridge 之后，`chat.cjs` 里还留着两处
   *   `pendingConfirms`（收尾 + 中断）。它是 ReferenceError，在 Promise 的 finally 里
   *   → **每轮结束都报一次未处理的拒绝**，而 tsc / 单测 / 自检全绿（那个文件不过 tsc）。
   *   批③ 真机跑第四段时才在日志里看到。
   */
  const chatFull = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check('★ chat.cjs 里没有搬家剩下的旧名字（ReferenceError 的那种）', !chatFull.includes('pendingConfirms'))
  check(
    '★ 收尾走 chatConfirm.closeOut（一轮结束时把挂着的那条结算掉）',
    (chatFull.match(/chatConfirm\.closeOut\(requestId\)/g) ?? []).length === 2,
    String((chatFull.match(/chatConfirm\.closeOut\(requestId\)/g) ?? []).length),
  )

  /* ── 一轮结束要能把属于这一轮的确认结算掉（按 owner 认领，不碰别的对话） ── */
  bridge.reset()
  const mine = bridge.ask({ timeoutMs: 5000, owner: 'req_a', emitReply: () => {} })
  const other = bridge.ask({ timeoutMs: 5000, owner: 'req_b', emitReply: () => {} })
  check('两条都挂着', bridge.pendingCount() === 2)
  const closed = chatConfirm.closeOut('req_a')
  check('★ 只结算自己那一轮（同时跑着另一条对话时不误伤）', closed.closed === 1 && bridge.pendingCount() === 1, JSON.stringify(closed))
  check('★ 结算成「拒绝」而不是超时（老路径拿到的还是布尔 false）', (await mine).approved === false && (await mine).timeout === false)
  bridge.reset()
  void other

  /* 端到端（内核侧）：工具 → 往返 → 答复 → 回到模型能读到的那段文本 */
  const askedByTool = []
  const toolCall = askUser.run(
    {
      questions: [
        { question: '用哪个包管理器？', options: [{ label: 'pnpm', effect: '仓库里有 pnpm-lock.yaml' }] },
      ],
    },
    { sessionId: 'selftest-clarify-emit', emit: (event) => askedByTool.push(event) },
  )
  for (let i = 0; i < 60 && askedByTool.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5))
  check(
    '★ 工具把 ctx.emit 递下去了（不递 → 卡片永远不出现）',
    askedByTool.length === 1 && askedByTool[0].type === 'confirm_request',
    JSON.stringify(askedByTool[0] ?? null).slice(0, 90),
  )
  bridge.settle(
    askedByTool[0].confirmId,
    true,
    JSON.stringify({ answers: [{ question: '用哪个包管理器？', choice: 'pnpm' }] }),
  )
  const toolOut = String(await toolCall)
  check('★ 答复最终回到模型（工具返回值里有 pnpm）', /pnpm/.test(toolOut), toolOut.slice(0, 70))
}
