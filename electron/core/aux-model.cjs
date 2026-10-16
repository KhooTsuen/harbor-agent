/**
 * **辅助任务**该用哪个模型（2026-10-17）
 *
 * ── 什么是「辅助任务」─────────────────────────────────────────
 *
 * 起标题 / 翻译 / 建议 / 压缩摘要 / 自检复核 —— 这些是**顺手活**，
 * 它们一律调 `llm.chatStream`（HTTP/SSE），**需要** baseUrl + 一个能用的 Key。
 *
 * ── ★ 为什么不能复用主任务的 provider（真机病）────────────────
 *
 * 主任务可以选 `codex-cli`（本机 CLI 子进程后端，`baseUrl` 是**空串**）。
 * 那时若辅助任务**沿用主任务的 provider**，就会拿空 baseUrl 去 `buildUrl()` ——
 * 请求必失败。实测过的那条：长对话触发压缩 → 压缩用空 baseUrl → 失败 →
 * 用户看到「上下文超限」却不知道是后端的锅。
 *
 * 所以辅助任务**自己挑一个能走 HTTP 的后端**，与主任务解耦。
 * 判据只有一处（`provider-kinds.canHttp`），不在这里另写一套。
 *
 * ── 三条口径 ──────────────────────────────────────────────────
 *
 *   ① **候选** = 「启用 + 能走 HTTP」的供应商（`canHttp`：非 CLI 后端 + baseUrl + 有 Key）。
 *   ② `config.scenes[scene]` **显式配了**就用它 —— 这就是「辅助模型」的**现成配置入口**
 *      （设置页「场景」那套），不新造字段。
 *   ③ 没配 → 候选里**第一个**（列表顺序 = 界面上看到的顺序）；
 *      模型名优先沿用全局 `assistant.model`，它不在对方能力范围时才退到对方的第一个。
 *   ④ **一个候选都没有 → `null`**（不猜、不偷偷回退到主任务那个必定失败的后端）。
 *      调用方拿到 null 就**跳过这台辅助活**（记一条日志），而不是硬发一次必失败的请求。
 *
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑它）。
 */

const kinds = require('./provider-kinds.cjs')
const configCore = require('./config.cjs')

/**
 * 挑一个能跑辅助任务的 HTTP 后端。
 *
 * @param {object} config 主进程配置
 * @param {{ scene?: string, hasKey?: (p: object) => boolean }} [options]
 *   `scene`：场景 id（'compact' / 'title' / …）—— 只看它有没有显式配置
 *   `hasKey`：注入判据（不传就用 `config.hasKey`；测试可以喂假的）
 * @returns {{ provider: object, model: string, source: string } | null}
 *          拿不到就是 `null`（**不是**回退到主任务那个）
 */
function resolveAux(config, options = {}) {
  const scene = String(options.scene ?? '')
  const hasKey = typeof options.hasKey === 'function' ? options.hasKey : configCore.hasKey
  const providers = Array.isArray(config?.providers) ? config.providers : []

  /* ① 候选：启用的 + 真的能走 HTTP 的 */
  const pool = providers.filter((p) => p?.enabled !== false && kinds.canHttp(p, hasKey))
  if (pool.length === 0) return null

  /* ② 场景显式配了辅助模型 → 用它（指的后端不在候选里就忽略，继续往下走） */
  const conf = scene ? config?.scenes?.[scene] : null
  if (conf?.providerId && conf?.model) {
    const hit = pool.find((p) => p.id === conf.providerId)
    if (hit) return { provider: hit, model: String(conf.model), source: `scenes.${scene}` }
  }

  /* ③ 默认：候选里第一个。模型名优先沿用全局那个（对方能提供才用） */
  const provider = pool[0]
  const wanted = String(config?.assistant?.model ?? '')
  const list = Array.isArray(provider.models) ? provider.models : []
  const model = list.length === 0 || list.includes(wanted) ? wanted || list[0] || '' : list[0] || ''
  if (!model) return null

  return { provider, model, source: 'first-http' }
}

module.exports = { resolveAux }
