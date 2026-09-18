/*
 * AG-011：流式增量的批处理
 *
 * ── 为什么要有它 ──
 *
 * 真机测出来的（`main.cjs` 里挂 500ms 心跳 + `process.cpuUsage()`）：
 *
 *   LAG 1222ms cpu=1453ms heap=10M rss=198M
 *   LAG 1789ms cpu=1672ms heap=11M rss=198M
 *
 * 两件事同时成立：**CPU 被吃满（还是多线程）**，而 **JS heap 只有 10~20M、
 * rss 却有 198M**。所以烧的不是 JS 计算、也不是 GC —— 是每个 token 一条
 * `webContents.send` 的**跨进程投递**：一场对话几千条，渲染层来不及消费就积压，
 * 主进程事件循环被拖到五六秒才转一圈（用户点「停止」的 IPC 要等十几秒才排上队）。
 *
 * ── 做法 ──
 *
 * 把 `content` / `reasoning` 的增量攒起来，每 50ms 发一条（20 条/秒）。
 * 人眼分不出这和逐字显示的差别，IPC 数量少一到两个数量级。
 *
 * ── 两条纪律 ──
 *
 *   · **结构性事件（工具、相位、错误、结束）必须立刻发**，而且发之前
 *     先把攒的增量冲掉 —— 顺序错了界面会「先显示结果、再显示过程」。
 *   · **收尾必须再冲一次**，否则最后一段文字会永远留在缓冲里。
 */

/** 50ms ≈ 20 条/秒 —— 再密人眼也看不出来，够流畅了 */
const DEFAULT_FLUSH_MS = 50

/**
 * @param {{ send: (type: string, text: string) => void, flushMs?: number }} options
 *   `send` 收到的是**合并之后**的 (类型, 文本)
 */
function createBatcher({ send, flushMs = DEFAULT_FLUSH_MS }) {
  /** @type {{ type: string, text: string } | null} */
  let batched = null
  let timer = null

  /** 把攒着的立刻发出去（没有就什么都不做，可重复调） */
  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!batched) return
    const { type, text } = batched
    batched = null
    send(type, text)
  }

  /** 收一段增量。同类型的会拼在一起，换类型就先冲一次（顺序不能乱） */
  function put(type, text) {
    if (!text) return
    if (batched && batched.type === type) {
      batched.text += text
    } else {
      flush()
      batched = { type, text }
    }
    if (!timer) timer = setTimeout(flush, flushMs)
  }

  return {
    put,
    flush,
    /** 还攒着多少（测试和收尾检查用） */
    get pending() {
      return batched ? batched.text : ''
    },
  }
}

module.exports = { createBatcher, DEFAULT_FLUSH_MS }
