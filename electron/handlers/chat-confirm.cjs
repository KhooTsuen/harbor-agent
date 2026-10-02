/**
 * 「问一句、等回话」的两条往返（AG-053 从 handlers/chat.cjs 拆出来的）
 *
 * 为什么拆：`chat.cjs` 是对话 IPC 的总入口，本身已经贴着 300 行红线；
 * 这一轮要给「写操作确认」再加一条「澄清提问」，塞进去就是 355 行。
 * 拆的原则是**按职责**：这个文件只干「挂一条请求 → 等渲染层回话 → 回话/超时」，
 * 对话怎么跑、事件怎么发都不归它管。
 *
 * ★ 两条路共用一条 IPC 通道（`chat:confirm`），但**回话形状不同**：
 *   · `askUser`（审批）  → resolve 一个**布尔**：只有 `approved === true` 才算同意
 *   · `askClarify`（澄清）→ resolve `{ answers, skipped, timeout }`
 *   自检 101 组钉的就是「老路不能被新参数改松」。
 *
 * ⚠️ 上限不一样的含义：
 *   · 审批超时 5 分钟 → 算**拒绝**（用户可能就是不想批）
 *   · 澄清超时 5 分钟 → 算**跳过**，且要带 `timeout: true` —— 上层据此走
 *     「按默认选项继续」，而不是当成「用户拒绝」（两者后果完全不同）
 */

const confirmBridge = require('../core/confirm-bridge.cjs')
const clarifyWatch = require('./clarify-watch.cjs')
const log = require('../core/log.cjs')

/*
 * 「卡片类往返」的常驻日志（2026-10-03 加）。
 *
 * 为什么要常驻（而不是出问题时临时打点）：用户报过「答完卡不消失 / 任务不继续」，
 * 而那条链路的三段（主进程发卡 → 渲染层回话 → 主进程结算）彼时**一行日志也没有** ——
 * 只能靠猜。现在三行就能分清楚：
 *   ① 卡发出去了吗（cardId）
 *   ② 回话落到一条**还没结算**的请求上了吗（`ok:false` = 已经过期 → 回话被丢）
 *   ③ 是不是被「一轮收尾」提前结算掉了（closed > 0）
 * 量很小（一张卡最多三行），每个卡都一样处理，不算噪声。
 */
const cardLog = log.tagged('澄清卡')

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000
const CLARIFY_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 澄清卡上除了「答」和「跳过」之外的两个**退出口**（AG-053 批⑤）。
 *
 * 它们和「跳过」走同一条 `chat:confirm`（`approved` 也是 false，**不开新通道**），
 * 区别只在回话 JSON 里多一个标记：
 *   · `{ cancel: true }`   → 「先不做了」：这一轮别动手了，写个交接收尾
 *   · `{ rephrase: true }` → 「换个说法」：问题没说清，重新组织一遍再问
 *
 * ★ 旧实现这个分支**直接 return，压根不看 `reply.answer`** —— 那两个出口会被
 *   当成「用户跳过了」。后果不是错一句话，是错一个状态：跳过计数是静音的判据
 *   （连跳两次就不再主动问），而点「先不做了」的人只是「这次先不做」，他却会
 *   被当成「又拒了一次」。拿用户没说过的话去记他，是这里最不能接受的一种错。
 *
 * 解析失败 / 老版本界面 → 返回空对象，仍然当跳过（不能把任务卡住）。
 *
 * @param {unknown} answer 渲染层回的 JSON 字符串
 * @returns {{cancelled?: true, rephrase?: true}}
 */
function exitsIn(answer) {
  try {
    const value = JSON.parse(String(answer ?? '') || '{}')
    const out = {}
    /* ★ 名字必须是 `cancelled`：渲染层 `types/clarify.ts` 里就叫这个。
       写成 `cancel`（少一个 l）不会报错、不会抛异常 —— 只是“这两个出口总是被当成跳过”，
       而自检 107 组的真往返一次就把它抓出来了。 */
    if (value?.cancelled === true) out.cancelled = true
    if (value?.rephrase === true) out.rephrase = true
    return out
  } catch {
    return {}
  }
}

/**
 * 审批：要不要让这一步执行。
 *
 * @param {string} requestId 对话的 requestId（只用来记日志，**不能当审批 id**）
 * @param {{ name?: string, summary?: string, args?: unknown, kind?: string, risk?: unknown,
 *           diff?: unknown, diffNote?: string, impact?: string[] }} request
 * @param {(event: Record<string, unknown>) => void} emit 推事件给渲染层
 * @returns {Promise<boolean>}
 */
function askUser(requestId, request, emit) {
  return confirmBridge
    .ask({
      timeoutMs: CONFIRM_TIMEOUT_MS,
      /* 属于这一轮：一轮结束时（成功/失败/中断）要把它结算掉，不能悬着 */
      owner: String(requestId ?? ''),
      payload: {
        /*
         * 审批 id（`approve_…`）**不能叫 requestId** —— 那是**对话的** requestId，
         * 两者同名会被上层展开覆盖，渲染层就收不到这条确认了（见 chat-emit.cjs）。
         */
        approvalId: request.requestId ?? null,
        toolName: request.name,
        summary: request.summary,
        args: request.args,
        kind: request.kind ?? '',
        risk: request.risk ?? null,
        /* AG-036：会改成什么样（`write_file` / `edit_file` 才有） */
        diff: request.diff ?? null,
        diffNote: request.diffNote ?? '',
        impact: request.impact ?? [],
      },
      emitReply: (payload) => emit({ type: 'confirm_request', ...payload }),
    })
    /* 老路：只取布尔。超时、拒绝、找不到都是 false（与以前一字不差） */
    .then((reply) => reply.approved === true)
}

/**
 * 澄清：把「需要用户拿主意」的问题摆给他（开工前对齐）。
 *
 * ★ 必须拿到**对话的事件通道**（`input.emit`）—— 不能用 `register()` 里那个裸 send：
 *   发布的地方得带 `chat:event` 频道，而**对话的 requestId 只有 emitter 会补**
 *   （`chat-emit.cjs` 把 `{ ...event, requestId }` 拼在最后）。渲染层按 requestId
 *   过滤（`turns.ts`：`event.requestId !== requestId` 就 return），少了它这条事件
 *   会被**静默丢掉** —— 卡片永远不出现、没有任何报错。
 *   批② 真机验证抓到的就是这个：`send(payload)` 少传了频道，链路上只剩
 *   「提问失败」，界面一片安静。
 *
 * ★ 拿不到通道就**别假装在问**：直接报 noWindow，让工具 fail-open 自己拍板。
 *   干等 5 分钟超时（用户什么都没看到）比立刻放行糟得多。
 *
 * @param {{ sessionId?: string, taskId?: string, questions?: unknown[],
 *           emit?: (event: Record<string, unknown>) => void, timeoutMs?: number }} input
 * @returns {Promise<{ answers: Array<{question: string, choice?: string, text?: string}>,
 *                    skipped: boolean, timeout: boolean, noWindow?: boolean, muted?: boolean }>}
 */
function askClarify(input = {}) {
  const emit = typeof input.emit === 'function' ? input.emit : null
  if (!emit) {
    /* 没有事件通道（定时任务 / 已退出 / 拿不到 emitter）：立刻说「问不了」 */
    return Promise.resolve({ answers: [], skipped: true, timeout: false, noWindow: true })
  }
  /*
   * 这个任务已经等得太久（累计离场超 `clarifyMaxWaitMs`）→ **不弹卡、不挂请求**。
   * 批③ 的巡查会把标记打上，但没人拦（只记了一行日志）——“本任务不再弹卡”当时是句空话。
   * 真机验这条才现形。
   */
  if (clarifyWatch.mutedFor(input.taskId)) {
    return Promise.resolve({ answers: [], skipped: true, timeout: false, muted: true })
  }
  /* 已经挂上了哪张卡（下面两个回调都要认它） */
  let cardId = ''
  return confirmBridge
    .ask({
      /*
       * 默认 5 分钟；**自检传小值**才能真跑到超时那一段（否则要干等 5 分钟）。
       * ★ 超时的返回形状是 `{ skipped: true, timeout: true, answers: [] }` ——
       *   两者都带 skipped，所以 `clarify.render()` 里**超时必须优先判**：
       *   判反了离场就被当成「用户说跳过」，模型再也看不到［默认］标记。
       *   批② 真机验证抓到的就是这个（自检当时的假数据没带 skipped，一路绿）。
       *
       * ⚠️ 这是**最后一道兜底**（界面上一直没人回话）。正常路径由
       *   `clarify-watch.cjs` 的离场巡查提前推进：用户走开 10 分钟就采纳默认，
       *   而“他在场想 20 分钟”不会被这个定时器打断（那个判据在状态机里）。
       */
      timeoutMs: Number.isFinite(input.timeoutMs) ? input.timeoutMs : CLARIFY_TIMEOUT_MS,
      idPrefix: 'clr',
      /* 属于哪一轮：从 emitter 上取（见 core/chat-emit.cjs 里那句 `emit.requestId`） */
      owner: String(input.emit?.requestId ?? ''),
      payload: {
        kind: 'clarify',
        sessionId: input.sessionId ?? '',
        taskId: input.taskId ?? '',
        questions: input.questions ?? [],
      },
      /* 走对话自己的 emitter：它才会把 requestId 补上去（看上面那段） */
      emitReply: (payload) => {
        cardId = String(payload.confirmId ?? '')
        cardLog.info(`发出 ${cardId}（会话 ${String(input.sessionId ?? '')}）`)
        /* 交给巡查器计时（没 start 过就 no-op，靠上面那个 5 分钟兜底） */
        clarifyWatch.arm({
          id: cardId,
          sessionId: input.sessionId ?? '',
          taskId: input.taskId ?? '',
          questions: input.questions ?? [],
          /*
           * ★ 判到离场 → 把这个请求**按超时推进去**。
           *   少了这一句，巡查只会发通知、任务照样等到 5 分钟的兜底定时器
           *   （批③ 真机第一遍就是这样：日志里通知发了，模型却再没被叫过）。
           */
          onSettle: () => confirmBridge.settleAsTimeout(cardId),
        })
        emit({ type: 'confirm_request', ...payload })
      },
    })
    .then((reply) => {
      if (cardId) clarifyWatch.resolve(cardId)
      if (reply.approved !== true) {
        /*
         * 跳过 / 超时 / 两个退出口：超时要让上层知道，好走「按默认选项继续」那条路。
         *
         * 离场超时是**外部时钟**推进的（巡查器 → `settleAsTimeout`），所以这里
         * 除了把结果返回给工具，还得**让界面把那张卡收起来** —— 不然用户回来
         * 看到一张还在等他的卡，而任务已经按默认选项跑完了。
         *
         * `skipped: true` 是**兼容形状**（上层只认这个字段），退出口靠额外的
         * 标记区分 —— `ask_user.cjs` 会先认标记再决定计不计「跳过」。
         */
        if (reply.timeout === true && cardId) {
          emit({ type: 'clarify.timeout', confirmId: cardId, sessionId: input.sessionId ?? '' })
        }
        const exits = exitsIn(reply.answer)
        return { answers: [], skipped: true, timeout: reply.timeout === true, ...exits }
      }
      try {
        const value = JSON.parse(reply.answer || '{}')
        return {
          answers: Array.isArray(value.answers) ? value.answers : [],
          skipped: value.skipped === true,
          timeout: false,
        }
      } catch {
        /* 回话不是 JSON（老界面 / 手滑）：当跳过，别把任务卡住 */
        log.warn('澄清答复解析失败，按跳过处理')
        return { answers: [], skipped: true, timeout: false }
      }
    })
}

/**
 * 一轮结束了（成功 / 失败 / 中断都走它）：把这一轮还挂着的确认按「拒绝」结算掉。
 *
 * 不结算就会：promise 一直悬着 + 界面上那张卡不消失（「任务都完了还在问我要不要允许」），
 * 要等 5 分钟的兜底定时器才自己灭。
 *
 * @param {string} requestId chat 的 requestId
 * @returns {{ closed: number }}
 */
function closeOut(requestId) {
  const result = confirmBridge.settleAllFor(requestId)
  /* closed > 0 = 这一轮结束时还有卡在等回话（用户可能正要答）—— 与 (b) 类问题直接相关 */
  if (result.closed > 0) cardLog.info(`轮末结算 ${result.closed} 条还没回话的卡`)
  return result
}

/** 注册 `chat:confirm`（两条往返共用；第三个参数是 AG-053 加的可选答复） */
function register({ ipcMain }) {
  ipcMain.handle('chat:confirm', (_event, confirmId, approved, answer) => {
    const result = confirmBridge.settle(confirmId, approved, answer)
    /*
     * `ok:false` = 这条 id 已经不在 pending 里了（超时 / 轮末结算 / 重复点）。
     * 那意味着**用户这次回话被丢了** —— 界面会顺从地收起卡，而主进程那边
     * 已经按「跳过/拒绝」继续了。以后遇到「答了却没反应」先看这一行。
     */
    cardLog.info(`回话 ${confirmId} ok=${result.ok === true}${result.error ? ` ${result.error}` : ''}`)
    return result
  })
}

module.exports = { register, askUser, askClarify, closeOut, CONFIRM_TIMEOUT_MS, CLARIFY_TIMEOUT_MS }
