/**
 * 系统提示的**头两层**：环境信息（静态）+ 当前时间（每轮都变）。
 *
 * 从 `loop-prompt.cjs` 搬出来的（AG-053 批④）：那边加了「静音 / 唤醒」的接线后
 * 顶到 300 行上限（硬约束 #2），而这两块是**纯拼字符串** ——
 * 不读上下文、不查状态，搬走不影响任何行为，是最好搬的一块。
 *
 * ⚠️ 两个坑：
 *   ① **当前时间必须单独一层、放在提示词最后**。DeepSeek 的 prompt 缓存是前缀匹配，
 *      把它放开头等于后面所有 token 每轮都失效（放最后，前面稳定区一直命中，
 *      命中 token 约 1/10 价）。`loop-prompt` 的装配顺序动不得，
 *      `06-prompt-state.mjs` 里有守卫盯着这个位置。
 *   ② 别和 `machine-env.cjs` 搞混：那份讲的是「这台机器上装了哪些命令」
 *      （shell 是 cmd 还是 bash 那一类），这里讲的是系统 / 工作目录 / 时间。
 */

/**
 * 环境信息（**静态部分**）。
 *
 * 只有「操作系统 / 工作目录 / 文件访问范围」这些基本不变的东西。
 * ⚠️ 当前时间**不在这里** —— 它每轮都变，放这层会把整个提示的缓存前缀冲掉。
 * 见 `currentTimeSection()`。
 */
function environmentSection({ workdir, assistantName = 'Agent' }) {
  return [
    `- 操作系统：${process.platform === 'win32' ? 'Windows' : process.platform}`,
    `- 工作目录：${workdir}`,
    '- 相对路径一律理解为相对工作目录。',
    '- **文件访问有范围限制**：默认只能读写工作目录内的文件。需要动外面的时候，',
    '  直接按绝对路径调用工具即可 —— 应用会弹窗让用户批准，批准后本次会话有效。',
    '  被拒绝时不要反复重试，问用户想怎么办。',
    `- 你是 ${assistantName}，跑在用户本机上。`,
  ].join('\n')
}

/**
 * 当前时间 —— **单独一层，放最后**。
 *
 * 它是唯一**每轮都变**的内容。DeepSeek 的 prompt 缓存是前缀匹配，
 * 把它放在开头等于让后面所有 token 每轮都没法命中。放最后，
 * 前面稳定的部分就能一直命中（命中 token 约 1/10 价）。
 */
function currentTimeSection() {
  return `- 当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`
}

module.exports = { environmentSection, currentTimeSection }
