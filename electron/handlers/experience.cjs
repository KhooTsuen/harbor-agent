/**
 * 经验（自我纠错闭环）的 IPC —— 设置页「经验与规则」那一页用
 *
 * 三个通道，都只读 + 一个「人做决定」：
 *   · `experience:list`   管理视图（看全库），每条带 `injectable` / `pending`
 *   · `experience:stats`  状态分布（空库时界面要说「还没有」而不是白屏）
 *   · `experience:review` 批准 / 驳回 / 恢复 —— **唯一**能让人改变状态的路
 *
 * 判据全在 `core/experience-*.cjs`，这里只做形状搬运：
 * handler 里**不许**出现 `status === 'verified'` 这类判断（那是 schema 的事，
 * 两边各写一份必然漂 —— 2026-10 栽过四次，见约束机制说明）。
 */
const store = require('../core/experience-store.cjs')

function register({ ipcMain }) {
  /*
   * 管理视图：**不传 projectId** = 看全库（语义同 memory-scope，见那边文件头）。
   * 设置页本来就是「我要管所有经验」的地方，按项目过滤反而看不到该批的那条。
   */
  ipcMain.handle('experience:list', (_event, options = {}) => ({
    ok: true,
    items: store.listForReview({
      status: String(options?.status ?? ''),
      includeClosed: options?.includeClosed === true,
    }),
    stats: store.stats(),
  }))

  ipcMain.handle('experience:stats', () => ({ ok: true, stats: store.stats() }))

  ipcMain.handle('experience:review', (_event, payload = {}) => {
    const result = store.review(String(payload?.id ?? ''), {
      action: String(payload?.action ?? ''),
      actionText: String(payload?.actionText ?? ''),
      note: String(payload?.note ?? ''),
    })
    /*
     * 失败的三种原因原样往上报（界面要能说清「为什么不让我批」）：
     * `needs_action`（没有可注入的做法）、`blocked`（状态不允许）、`no_such_item`。
     */
    return result.ok
      ? { ok: true, item: store.describeForReview(result.item), stats: store.stats() }
      : { ok: false, error: result.error, reason: result.reason ?? '', stats: store.stats() }
  })
}

module.exports = { register }
