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
  const batcher = createBatcher({
    send: (type, text) => send('chat:event', { requestId, type, text }),
  })

  function emit(event) {
    const { type, ...payload } = event
    bus.emit(type, payload, { taskId: phaseKey })
    metrics.observe(phaseKey, event)

    if ((type === 'content' || type === 'reasoning') && typeof event.text === 'string') {
      batcher.put(type, event.text)
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
    send('chat:event', { ...event, requestId })
  }

  return { emit, flush: batcher.flush }
}

module.exports = { createEmitter }
