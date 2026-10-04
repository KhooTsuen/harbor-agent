/**
 * 配置：`assistant.model` 得真的有人提供
 *
 * 从 `config-normalize.cjs` 拆出来的（那个文件只剩十来行余量，而这一段
 * 是**独立的一件事**：跟 provider 列表比对模型名，和「主题 / 字号 / 开关」
 * 那些字段的夹取不是一回事）。
 *
 * ⚠️ 这条是审计问题 25 的修复：`assistant.model` 以前只做 `str()` 兜底，
 * 不校验「模型是不是真的在某个供应商的 models 列表里」。后果实测过：
 * 某台机器上 `models: ['deepseek-flash', 'deepseek-v4-pro']` 而
 * `assistant.model` 还是默认的 `deepseek-chat` —— 界面下拉显示 flash/v4-pro、
 * 实跑 deepseek-chat，模型选择与实际请求**脱节**（API 端一停用旧名字就直接 4xx）。
 *
 * ── 判据为什么是「任何已启用的供应商提供它」而不是「当前供应商提供它」 ──
 *
 * 运行时的选择是 `config.providerForModel(model, cfg)`（`loop-route.providerForRun`
 * 调它）：它按**模型**去已启用的供应商里找一个 `models` 里含这个名字的，
 * `models` 为空 = 没声明支持哪些 → 当作「都能」。所以只要**有人**提供它，
 * 运行时就能找到家 —— 这里跟着同一套语义走，才不会出现
 * 「normalize 说不行、运行时其实跑得好好的」这种两套判据。
 *
 * 反过来：**没有**任何供应商声明提供它 → 回落到「第一个声明了模型的供应商」
 * 列表里的第一个（列表顺序就是界面上的顺序），并记一条日志留痕。
 */

const DEFAULT_MODEL = 'deepseek-chat'

/** 这个供应商提供这个模型吗（models 为空 = 没声明 → 当作「都能」，与运行时同口径） */
function serves(provider, model) {
  const list = Array.isArray(provider?.models) ? provider.models : []
  return list.length === 0 || list.includes(model)
}

/**
 * @param {unknown} raw 配置里写的 `assistant.model`
 * @param {Array<{ enabled?: boolean, models?: string[] }>} providers 已规范化的供应商列表
 * @param {{ warn?: (message: string) => void }} [log] 不传就用内核日志
 *   （懒 require：`config-normalize` 那边为了行数没在顶层引 log —— 那条链在启动最早期，
 *   少一条顶层边少一个序问题）
 * @returns {string} 最终生效的模型名
 */
function pickModel(raw, providers, log) {
  const wanted = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_MODEL
  const enabled = (Array.isArray(providers) ? providers : []).filter((p) => p?.enabled !== false)
  /* 一个供应商都没有（或全是 models 空列表）= 声明不到位，不在这里改用户的选择 */
  if (enabled.length === 0 || enabled.some((p) => serves(p, wanted))) return wanted

  const declared = enabled.find((p) => Array.isArray(p.models) && p.models.length > 0)
  const fallback = declared ? String(declared.models[0]) : ''
  if (!fallback) return wanted

  const warn = log?.warn ?? require('./log.cjs').warn
  warn(
    `assistant.model「${wanted}」不在任何已启用供应商的模型列表里 —— ` +
      `回落到「${fallback}」（${declared.name ?? declared.id ?? '未命名'} 的第一个模型）。` +
      '要改回去：在「设置 → 模型」里选一个这台机器真的有的模型。',
  )
  return fallback
}

module.exports = { pickModel, serves, DEFAULT_MODEL }
