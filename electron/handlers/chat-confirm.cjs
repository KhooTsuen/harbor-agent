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
const log = require('../core/log.cjs')

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000
const CLARIFY_TIMEOUT_MS = 5 * 60 * 1000

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
  void requestId
  return confirmBridge
    .ask({
      timeoutMs: CONFIRM_TIMEOUT_MS,
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
 *                    skipped: boolean, timeout: boolean, noWindow?: boolean }>}
 */
function askClarify(input = {}) {
  const emit = typeof input.emit === 'function' ? input.emit : null
  if (!emit) {
    /* 没有事件通道（定时任务 / 已退出 / 拿不到 emitter）：立刻说「问不了」 */
    return Promise.resolve({ answers: [], skipped: true, timeout: false, noWindow: true })
  }
  return confirmBridge
    .ask({
      /*
       * 默认 5 分钟；**自检传小值**才能真跑到超时那一段（否则要干等 5 分钟）。
       * ★ 超时的返回形状是 `{ skipped: true, timeout: true, answers: [] }` ——
       *   两者都带 skipped，所以 `clarify.render()` 里**超时必须优先判**：
       *   判反了离场就被当成「用户说跳过」，模型再也看不到［默认］标记。
       *   批② 真机验证抓到的就是这个（自检当时的假数据没带 skipped，一路绿）。
       */
      timeoutMs: Number.isFinite(input.timeoutMs) ? input.timeoutMs : CLARIFY_TIMEOUT_MS,
      idPrefix: 'clr',
      payload: {
        kind: 'clarify',
        sessionId: input.sessionId ?? '',
        taskId: input.taskId ?? '',
        questions: input.questions ?? [],
      },
      /* 走对话自己的 emitter：它才会把 requestId 补上去（看上面那段） */
      emitReply: (payload) => emit({ type: 'confirm_request', ...payload }),
    })
    .then((reply) => {
      if (reply.approved !== true) {
        /* 跳过 / 超时：超时要让上层知道，好走「按默认选项继续」那条路 */
        return { answers: [], skipped: true, timeout: reply.timeout === true }
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

/** 注册 `chat:confirm`（两条往返共用；第三个参数是 AG-053 加的可选答复） */
function register({ ipcMain }) {
  ipcMain.handle('chat:confirm', (_event, confirmId, approved, answer) =>
    confirmBridge.settle(confirmId, approved, answer),
  )
}

module.exports = { register, askUser, askClarify, CONFIRM_TIMEOUT_MS, CLARIFY_TIMEOUT_MS }
