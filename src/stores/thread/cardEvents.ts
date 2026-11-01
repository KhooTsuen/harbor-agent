/**
 * 交互卡的三个事件入口（2026-10-21 从 streamEvents.ts 拆出 —— 那边贴 300 行）
 *
 * ── 三个事件 ───────────────────────────────────────────────
 *
 *   · `confirm_request` —— 写操作要用户点头 → 弹审批卡（`confirmEvents.askPermissionFor`）
 *   · `clarify.timeout` / `confirm.timeout` —— 两类卡的「超时作废」都要收卡
 *
 * ── 审批超时那条为什么必须收 ───────────────────────────────
 *
 * 2026-10-07 补的：不收卡会把**后面所有澄清卡挡死**（前一张卡永远挂着，
 * 新的一张排不进来）。所以它和澄清超时走同一个入口，理由写在
 * `confirmEvents.onCardTimeout`，这里只是转发。
 *
 * ⚠️ 本文件只做转发的另一个原因：`gateCard.test` / `clarifyCard.test` 钉的是
 *    `confirmEvents.ts` 里的行为，把逻辑搬到这里会让那两组测试测不到真东西。
 */
import { askPermissionFor, onCardTimeout } from './confirmEvents'

/**
 * @returns 是否处理了这个事件（三个都恒为 true —— 认得了就不往后传）
 */
export function handleCardEvent(event: Record<string, unknown>, type: string): boolean {
  try {
    if (type === 'confirm_request') {
      askPermissionFor(event)
      return true
    }
    onCardTimeout(event)
  } catch {
    /*
     * 卡没收成不能让整条事件链断掉：抛出去会跳过后面所有分支（这一轮再也收不了尾）。
     * 失败本身由 confirmEvents / 调用方各自的日志记录。
     */
  }
  return true
}
