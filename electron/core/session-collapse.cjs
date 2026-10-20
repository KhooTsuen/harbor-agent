/**
 * 会话存储：按 key 收敛流式快照
 *
 * 从 session-read.cjs 拆出来的（2026-10-20：那边贴 300 行红线，而这次要给
 * `list()` 加异步 + 缓存，必须先腾出位置）。函数体与拆分前**逐字一致** ——
 * 自检 `53-partial-persist` 直接 require 它，行为一改就红。
 */

/**
 * 把带 key 的记录收敛成一条。
 *
 * 流式过程中渲染层会往文件里**追加同一 key 的分段快照**（`partial: true`）——
 * 那是为了进程被强杀 / 崩溃时还能留下「它写到哪了」（会话文件是追加式的，
 * 没地方原地更新）。收尾时再追加一条完整的（不带 partial）。于是同一个 key
 * 在文件里可能有好几行，这里要把它们合成一条：
 *
 *   · 只要有**完整**的那条，就用它 —— 而且**不赌行序**：追加是异步的
 *     （`void appendToDisk(...)`），分段晚于完整到达也不会把完整那条顶掉
 *   · 全是分段快照 → 用**最后一条**，并标上 `interrupted: true`
 *     （界面据此说一句「这条没写完」，不然用户以为模型就写了这么多）
 *
 * 没有 key 的老记录各算一条，行为与以前一样。
 */
function collapseByKey(messages) {
  /*
   * 兼容这次改动**之前**写下的用户记录：那时候用户消息没有 key，
   * 而"编辑"会新增一条带 key + 版本表的记录（v1 就是原文）。
   * 两者其实是同一条消息的两个版本，不去重的话老会话里会显示成两条一样的提问
   * （用户报的就是这个现象）。
   *
   * 规则：无 key 的用户记录，只要它的内容等于某条带版本表记录的**第 1 版**，
   * 而且它排在那条之前，就当同一条消息的旧版本丢掉。
   * 代价：同一句话真的问了两遍、又改了后一条时，前一条会被吞掉 —— 这种情形
   * 两句话本来就长得一模一样，接受。
   */
  /*
   * ★ 只认「紧挨在这条带版本表的记录之前的最后一条无 key 用户记录」。
   *
   * 以前是「只要内容等于某条版本表的第 1 版就丢」—— 太宽了：同一句话**问了两遍**
   * （两轮独立对话）时，前面那几轮的无 key 提问会被一起吃掉，它们的回答就失去了
   * 归属，重新打开会话时并排堆在上一轮后面（真机上就是这么看见的）。
   * 老会话里「编辑」产生的形态是 [旧提问(无 key), 旧回答, 新提问(带 key + 版本表)] ——
   * 旧提问正好是**最后一条**无 key 用户记录，所以这条判据够用，又不会连坐前面的轮次。
   */
  const originalTexts = new Map()
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]
    if (m.role === 'user' && Array.isArray(m.versions) && m.versions.length > 1) {
      const text = String(m.versions[0] ?? '')
      if (text && !originalTexts.has(text)) originalTexts.set(text, i)
    }
  }
  /* 每条带版本表的记录：在它之前、与它之间**没有别的用户记录**的那条无 key 提问才是旧版本 */
  const superseded = new Set()
  for (const [text, at] of originalTexts) {
    for (let i = at - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m.role !== 'user') continue
      if (!m.key && String(m.content ?? '') === text) superseded.add(i)
      break /* 只认最近的那一条用户记录 */
    }
  }

  const out = []
  const slot = new Map()
  const hasFinal = new Set()
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    const key = typeof message.key === 'string' && message.key ? message.key : ''
    if (!key) {
      if (superseded.has(i)) continue
      out.push(message)
      continue
    }
    const at = slot.get(key)
    if (message.partial === true) {
      /* 已经有完整的那条了 → 晚到的快照直接丢掉 */
      if (hasFinal.has(key)) continue
      if (at === undefined) {
        slot.set(key, out.length)
        out.push({ ...message, interrupted: true })
      } else {
        out[at] = { ...message, interrupted: true }
      }
      continue
    }
    hasFinal.add(key)
    if (at === undefined) {
      slot.set(key, out.length)
      out.push(message)
    } else {
      out[at] = message
    }
  }
  return out
}

module.exports = { collapseByKey }
