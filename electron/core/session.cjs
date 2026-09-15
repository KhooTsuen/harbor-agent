/**
 * 会话存储（门面）
 *
 * 会话格式：一个会话一个 .jsonl 文件，**追加式**写。
 *   · 第一行永远是 meta（标题/时间/模式/模型）
 *   · 之后每行一条事件（消息、工具调用、压缩点、会话状态）
 *
 * 为什么用 JSONL 而不是一个大 JSON：
 *   · 追加就是 append，不用整篇重写（长对话不会越写越慢）
 *   · 中途崩了只丢最后一行，前面的还能读
 *   · 出问题时可以直接用文本编辑器看
 *
 * 实现拆成三个：
 *   · session-io.cjs     文件在哪、怎么按行读写（两个方向都要用）
 *   · session-read.cjs   列会话 / 读会话 / 搜索 / 转成模型要的 messages
 *   · session-write.cjs  新建 / 追加 / 改 meta / 删 / 导入
 *
 * 这个文件只是把它们拼回原来那个接口 —— 别处照旧 `require('./session.cjs')`，
 * 一行都不用改。
 */

const read = require('./session-read.cjs')
const write = require('./session-write.cjs')
const { fileFor, safeTitle } = require('./session-io.cjs')

module.exports = {
  /* 读 */
  list: read.list,
  load: read.load,
  search: read.search,
  workdirs: read.workdirs,
  toApiMessages: read.toApiMessages,

  /* 写 */
  create: write.create,
  append: write.append,
  appendCompact: write.appendCompact,
  appendState: write.appendState,
  updateMeta: write.updateMeta,
  remove: write.remove,
  removeAll: write.removeAll,
  importThreads: write.importThreads,

  /* 原语 */
  fileFor,
  safeTitle,
}
