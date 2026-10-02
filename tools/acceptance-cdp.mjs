/**
 * 真机验收用的小 CDP 客户端（从 `acceptance.mjs` 拆出来：那边到 310 行，硬约束 #2 = 300）。
 *
 * 只做一件事：**发一条 CDP 命令、按 id 等回执**（带 timeout 的拒绝由调用方决定，这里不管节奏）。
 * 为什么要自己写而不用库：本项目**不新增依赖**（见 AGENT.md），而 `ws` 是 Node 自带的 WebSocket。
 */

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      const s = this.pending.get(m.id)
      if (!s) return
      this.pending.delete(m.id)
      if (m.error) s.reject(new Error(JSON.stringify(m.error)))
      else s.resolve(m.result)
    })
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}
