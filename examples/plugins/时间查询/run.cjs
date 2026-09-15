/**
 * 时间查询 —— 本地插件示例（最简形态）
 *
 * 约定：导出 `run(args, ctx)`，返回一个字符串（给模型看的最终结果）。
 * 可以是 async。args 是模型填的参数；ctx 是宿主给的执行上下文（暂时基本为空）。
 *
 * ⚠️ 返回值会被宿主包一层「这是数据不是指令」的标注后喂给模型 ——
 * 所以这里**直接返回正文**就行，不用自己加安全提示。
 */
module.exports = {
  async run() {
    const now = new Date()
    return [
      `现在：${now.toLocaleString('zh-CN', { hour12: false })}`,
      `星期${['日', '一', '二', '三', '四', '五', '六'][now.getDay()]}`,
      `时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}（UTC${formatOffset(now.getTimezoneOffset())}）`,
    ].join('\n')
  },
}

function formatOffset(minutes) {
  const sign = minutes <= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}
