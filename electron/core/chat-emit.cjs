/*
 * 「把 Agent 事件推出去」这件事（AG-011 从 chat.cjs 抽出来的）
 *
 * 一条事件出去要经过三个地方，顺序有讲究：
 *
 *   ① `bus.emit`          —— AG-002 的总线（统一结构 + 环形缓冲 + agent.* 落盘）
 *   ② `metrics.observe`   —— AG-003 的时间线（认领首反馈 / 首 token / 首工具 / 结束）
 *   ③ `send('chat:event')` —— 推给渲染层
 *
 * ③ 是最贵的一条。真机测出来主进程事件循环会被卡 5~14 秒，CPU 吃满而
 * JS heap 只有 10~20M —— 烧的不是 JS，是**每个 token 一条跨进程投递**。
 * 所以正文和思考的增量走批处理器（20 条/秒），其余立刻发，
 * 但发之前先把缓存冲掉（顺序不能乱，否则界面「先显示结果、再显示过程」）。
 */

const bus = require('./events.cjs')
const metrics = require('./metrics.cjs')
const { createBatcher } = require('./stream-batch.cjs')

/**
 * @param {{ requestId: string, phaseKey: string, send: (channel: string, payload: object) => void }} options
 */
function createEmitter({ requestId, phaseKey, send }) {
  /*
   * ── 事件序号（2026-11-09，真实执行顺序）────────────────────────
   *
   * 为什么要有它：渲染层一直靠**到达顺序**处理事件。IPC 同一通道是保序的，
   * 所以「平时」看是对的 —— 但一旦有批处理（正文 20 条/秒攒一批）和结构事件
   * （工具 / 重试 / 结束）交错，顺序就只能靠「flush 得够不够及时」保证，
   * 而且**不可观测**：出问题时没人能证明「界面显示的顺序 = 真实发生的顺序」。
   *
   * 现在每条发出去的事件都带 `seq`（本执行内从 1 递增），渲染层拿到就能：
   *   · 断言「不回退」（小于上次的 seq 视为乱序，记一次告警而不是静默接受）
   *   · 落盘后回放时按它重排，不再依赖 `reconcileFinalRounds` 猜正文该并到哪
   *
   */
  let seq = 0
  const batcher = createBatcher({
    send: (type, text, stage) =>
      send('chat:event', { requestId, type, text, ...(stage ? { stage } : {}), seq: ++seq }),
  })

  function emit(event) {
    const { type, ...payload } = event
    bus.emit(type, payload, { taskId: phaseKey })
    metrics.observe(phaseKey, event)

    if ((type === 'content' || type === 'reasoning') && typeof event.text === 'string') {
      const stage = event.stage === 'answer' || event.stage === 'process' ? event.stage : undefined
      batcher.put(type, event.text, stage)
      return
    }
    batcher.flush()
    /*
     * ⚠️ `requestId` 必须放在**最后**。事件本身也可能带一个 requestId
     * （`confirm_request` 携带的是审批 id `approve_…`，见 tools/approval.cjs），
     * 展开写在后面会把对话的 requestId **顶掉** —— 渲染层是按 requestId 过滤的
     * （turns.ts：`event.requestId !== requestId` 就 return），一顶掉整条确认
     * 事件就被丢掉，**界面永远不弹权限条**，用户只能等到 5 分钟超时被当成拒绝。
     * 2026-09-25 真机抓到的：事件到了渲染层，权限条就是不出现。
     */
    send('chat:event', { ...event, requestId, seq: ++seq })
  }

  /**
   * 这个 emitter 属于哪一轮（chat 的 requestId）。
   *
   * AG-053 批③：澄清那条往返拿不到 requestId（工具只能把 emitter 递过去），
   * 而「这一轮结束时把还没回话的确认结算掉」得按 requestId 认领 —— 就挂在这里，
   * 比再传一个参数穿四层便宜。
   */
  emit.requestId = requestId

  return { emit, flush: batcher.flush }
}

module.exports = { createEmitter }
