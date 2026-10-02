/**
 * ask_user 工具（AG-053）—— 让模型在开工前把「需要用户拿主意」的地方摆出来
 *
 * 链路：模型调它 → 校验（`core/clarify.cjs`）→ 静音了就直接回「别问了」→
 *       否则走 `ctx.clarify` 那条往返（渲染层弹卡片，用户选/补充/跳过）→
 *       把答复当**工具结果**返回给模型 → 模型再开工。
 *
 * ★ 三条边界：
 *   ① **不问就干活不算错，问错才错** —— 参数坏掉（没问题可问）时返回一句说明，
 *      而不是抛错让整轮废掉。
 *   ② **通道没接上时放行**（fail-open）：`ctx.clarify` 不存在（老版本 / 自检）
 *      就回「按你自己判断做，并说明理由」—— 不能因为一个辅助能力缺失，
 *      把用户的任务卡死。
 *   ③ 它是**只读**工具：不改文件、不跑命令，所以**不进** `WRITE_TOOLS`（ask 档不弹
 *      权限确认 —— 澄清卡本身就是「问用户」，再叠一层权限确认是两遍）。
 */

const clarify = require('../clarify.cjs')

/**
 * 谁能把问题送到界面上？
 *
 * ★ 写法照 `browse.cjs`：**惰性 require handler**（那边也是「工具 → 渲染层往返」，
 *   同样不能顶层 require —— handler 要 electron，而自检是在纯 Node 里加载工具的）。
 *
 * 三种情形要分清：
 *   ① `ctx.clarify === null` —— 显式关掉（自检/探针要验 fail-open 那条路）；
 *   ② `typeof ctx.clarify === 'function'` —— 注入的（测试用假函数）；
 *   ③ 都没有 —— 真机：惰性拿 `handlers/chat.cjs` 的 `askClarify`。
 * 拿不到（纯 Node / 未来改名）就返回 null，调用方 **fail-open**。
 */
function transportOf(ctx) {
  if (ctx.clarify === null) return null
  if (typeof ctx.clarify === 'function') return ctx.clarify
  try {
    /* 找的是 chat-confirm.cjs（不是 chat.cjs）—— 那条往返住在它自己模块里 */
    const chat = require('../../handlers/chat-confirm.cjs')
    return typeof chat.askClarify === 'function' ? chat.askClarify : null
  } catch {
    return null
  }
}

module.exports = {
  name: 'ask_user',
  description: [
    '在动手之前，把「需要用户拿主意」的地方摆出来问他。每个问题给 2–4 个选项，',
    '每个选项都要写清「因为 X，所以会有 Y 效果」——X/Y 要是**具体数字或事实**',
    '（比如「多花 30 秒」「会新增 3 个文件」），不要写「更好」「更稳妥」这种主观判断。',
    '还要给每个问题标一个默认选项，默认必须是改动最小、最容易回滚、风险最低的那个：',
    '如果没有收到答复（用户离场），会按它继续。',
    '适合问：需求含糊有多种合理解法、做法不可逆、影响范围说不清。',
    '不适合问：能从代码或文件里查出来的事、纯风格偏好、一句话就能答完的活。',
    '一次最多问 3 个问题，用户答完才开工。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: '要问的问题（最多 3 个）',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '一句话说清要拿什么主意' },
            options: {
              type: 'array',
              description: '2–4 个选项',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '选项本身（短，用户一眼能选）' },
                  effect: {
                    type: 'string',
                    description: '因为 X 所以会有 Y 效果 —— 具体数字或事实',
                  },
                },
                required: ['label', 'effect'],
              },
            },
            defaultValue: {
              type: 'string',
              description: '默认选项的 label（没收到答复时会选它，必须是改动最小的那个）',
            },
            allowFreeform: {
              type: 'boolean',
              description: '还允许用户自己写一句（默认 true）',
            },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },

  async run(args, ctx = {}) {
    const sessionId = String(ctx.sessionId ?? '')
    const checked = clarify.normalize(args?.questions)
    /* 参数全坏（模型没给问题 / 问题全是空的）：返回一句说明，不让整轮废掉 */
    const unusable = () => {
      const why = checked.dropped.map((one) => one.reason).join('；') || '没给问题'
      return `这次没能问出去（${why}）。按你自己判断最稳妥的做法开工，并说明你的选择理由。`
    }

    /*
     * ★ 无人值守（定时任务）：**不弹卡、不挂请求、直接按默认选项开工**。
     *
     * 这条必须排在最前面（连静音都排在后面）：定时任务的语义就是没人在场 ——
     * 挂一张没人能看见、也没人能回答的卡，只会让任务干等到超时。
     * 而且这里**不许**调 transport：调了就会在主进程留一条待回话的请求
     * （自检断言 `pendingCount() === 0`）。
     *
     * 返回的那段文本本身就是**留痕**：它会作为工具结果进这条会话的记录，
     * 用户回头翻得到「哪次定时运行替他把哪个默认选项定了」。
     */
    if (clarify.isUnattended(sessionId)) {
      return checked.questions.length === 0
        ? unusable()
        : clarify.render(checked.questions, { unattended: true })
    }

    /* 静音：这个对话连跳两次了，别再问 */
    if (clarify.muted(sessionId)) {
      return (
        '用户已经连续跳过两次澄清（本对话内不再主动问）。' +
        '按你自己判断最稳妥的做法直接开工，并在回复里用一行说明「我选了 X，因为 Y」。' +
        '如果他明确说想被问（比如「你问我几个问题」），下一次再问。'
      )
    }

    if (checked.questions.length === 0) return unusable()

    /* 通道没接上（自检、老版本、没有窗口）：放行，别把任务卡住 */
    const transport = transportOf(ctx)
    if (typeof transport !== 'function') {
      return '这个版本没有接上澄清通道（或当前环境拿不到界面）。直接按你判断最稳妥的做法开工，并说明理由。'
    }

    let reply = null
    try {
      reply = await transport({
        kind: 'clarify',
        sessionId,
        taskId: String(ctx.taskId ?? ''),
        questions: checked.questions,
        /* 校验层的警告带上：通知与日志里能看到「模型没写具体数字」这种质量问题 */
        warnings: checked.warnings,
        dropped: checked.dropped,
        /*
         * ★ 必须把**对话自己的事件通道**递过去：卡片事件要带对话的 requestId
         *   （渲染层按它过滤，`turns.ts`：不匹配就 return）。`ctx.emit` 是循环里
         *   那个 emitter，requestId 由它补；拿不到（自检 / 注入式调用）就传 null，
         *   下游会报 noWindow 并**立刻放行**，而不是干等 5 分钟。
         */
        emit: typeof ctx.emit === 'function' ? ctx.emit : null,
      })
    } catch (error) {
      return `提问失败（${error instanceof Error ? error.message : String(error)}）。按你自己判断开工，并说明理由。`
    }

    /*
     * 这个任务**累计离场等待**超上限了（`clarifyMaxWaitMs`）——「本任务不再弹卡」就是这一支。
     *
     * 判定在主进程那一侧（状态在巡查器里，内核工具碰不到），所以只能从 `reply` 认；
     * 不认的话工具会当成「用户跳过了」去计数 —— 那是拿系统决定去静音用户。
     */
    if (reply?.muted === true) {
      return (
        '这个任务的澄清已经等得太久（累计离场超过上限），本任务不再问了。' +
        '按你自己判断最稳妥的做法直接开工，并在回复里用一行说明「我选了 X，因为 Y」，' +
        '顺便说清哪几条是替你定的（他会回来看）。'
      )
    }

    /*
     * 「先不做了」（批⑤）：这一轮**别动手**了。
     *
     * ★ 不算跳过、不静音：「这次先不做」和「别老问我」是两件事，拿前者去
     *   累加后者的计数，下次他想被问的时候会发现卡不出来了。
     * ★ 任务那边由界面**同时**调 `chat:pause` 停在安全点（台账变 paused，
     *   任务列表里点「继续」就能接着做）—— 那是现成链路，这里只管措辞。
     * 返回的这段文本本身就是**留痕**：它作为工具结果进这条会话的记录。
     */
    if (reply?.cancelled === true) return clarify.render(checked.questions, { cancelled: true })

    /*
     * 「换个说法」（批⑤）：问题没说清，重新组织一遍再问。
     *
     * ★ 上限（REPHRASE_LIMIT）：到顶了就按静音那一套收尾 —— 否则
     *   「用户说没说清 / 模型再问」可以无限循环，双方都没做错什么，
     *   但这一轮对话全耗在上面了。
     */
    if (reply?.rephrase === true) {
      if (clarify.noteRephrase(sessionId) > clarify.REPHRASE_LIMIT) {
        return (
          `「换个说法」已经用过 ${clarify.REPHRASE_LIMIT} 次了，这次别再问。` +
          '按你自己判断最稳妥的做法直接开工，并在回复里用一行说明「我选了 X，因为 Y」，' +
          '顺便说清哪几条是你替他定的（他会回来看）。'
        )
      }
      return clarify.render(checked.questions, { rephrase: true })
    }

    /* 用户跳过 → 计数 +1；答了 → 清零。静音判定只看这个计数 */
    if (reply?.timeout === true) {
      /*
       * 离场既不算跳过也不算答过：他没看到卡片，拿他**没做过的事**去静音他是错的。
       * （超时也带 `skipped: true`，所以这条必须写在前面。）
       */
    } else if (reply?.skipped === true) clarify.noteSkip(sessionId)
    else if (Array.isArray(reply?.answers) && reply.answers.length > 0) clarify.noteAnswered(sessionId)

    return clarify.render(checked.questions, reply ?? {})
  },

  summarize(args) {
    const list = Array.isArray(args?.questions) ? args.questions : []
    const first = String(list[0]?.question ?? '').slice(0, 60)
    return `问用户 ${list.length} 个问题${first ? `：${first}` : ''}`
  },
}
