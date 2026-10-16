/**
 * 后端**种类**（`provider.kind`）—— 唯一一处定义（2026-10-17）
 *
 * ── 为什么要有这个模块 ────────────────────────────────────────
 *
 * `kind` 决定「怎么调这个模型」，而**判据要在好几处用**：
 *   · `config.cjs` 的 `providerForModel`（挑选时：没有 Key 的后端也算可用）
 *   · `loop-route.cjs` 的 `providerForRun`（发请求前：别因为「没 Key」就报错）
 *   · `config-normalize-parts.cjs`（读进来时：判合法值 + 回落）
 *   · `provider-capabilities.cjs`（声明能力时：按种类覆盖，见设计 §4）
 * 硬约束 #9：**字符串契约只有一处**。所以常量与判据都放这里，别处 require 它。
 *
 * ── ★ 为什么需要「不需要 Key」这个概念 ────────────────────────
 *
 * `codex-cli` 的推理走**本机已登录的 CLI**，凭据由 CLI 自己管（`~/.codex/`）——
 * Harbor 一个字节都不碰，所以它**没有 `credentialRef`**。
 * 而现有挑选逻辑一律要求「有 Key」，会把这种后端**静默丢掉**：用户选了它的模型，
 * 实际却落到别的供应商（`config-model.cjs` 文件头记的那个「看似可用、实际不是它」）。
 * 所以把「需不需要 Key」抽成一个概念，让**路由链**按它放行。
 *
 * ⚠️ **只加宽路由链**，不动 `config.hasKey()` 本身 —— 那个函数被 9 个模块用
 *   （prewarm / router / scene / compact / diagnostics…），改它的语义会波及旁路。
 *   旁路继续看到「codex-cli 没 Key」而跳过它，这是**想要的**（实验性后端不进旁路）。
 *
 * 设计全文见 `docs/research/codex-cli-adapter-design.md`。
 */

/** HTTP / SSE 后端（`llm.cjs`）—— 也是**缺省值** */
const OPENAI = 'openai'
/** 本机 ChatGPT Codex CLI 子进程后端（`codex-cli.cjs`）—— 实验性，无原生工具调用 */
const CODEX_CLI = 'codex-cli'

/** 认识的种类。加种类时**这里是唯一入口**（规范化层用它做白名单） */
const KINDS = [OPENAI, CODEX_CLI]

/** 把任意输入收成一个合法 kind：不认识 / 非字符串一律回落 `openai`（不信任输入） */
function normalizeKind(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return KINDS.includes(value) ? value : OPENAI
}

/** 这个供应商是不是 codex-cli 后端 */
function isCodexCli(provider) {
  return normalizeKind(provider?.kind) === CODEX_CLI
}

/**
 * 这个供应商**需不需要 API Key**。
 *
 * `false`（不需要）目前只有 codex-cli：它用 CLI 的登录态，Harbor 不存凭据。
 * 路由链据此放行；其余一切照旧要求 Key。
 */
function needsKey(provider) {
  return !isCodexCli(provider)
}

/**
 * 这个供应商**现在真的能走一次 HTTP 请求**吗（辅助任务用）。
 *
 * 辅助任务（起标题 / 压缩摘要 / 自检复核）调的是 `llm.chatStream` ——
 * 它们**需要** baseUrl + 一个能用的 Key。走子进程的后端（codex-cli）在这条路上
 * 必然失败（`baseUrl` 是空串 → 拼不出 URL），所以必须排除掉。
 *
 * ★ 判据放这里，别处 require 它（硬约束 #9）。三个条件缺一不可：
 *   kind 不是 CLI 后端 · baseUrl 非空 · 有 Key。
 *
 * @param {object} provider
 * @param {(p: object) => boolean} hasKey 判断「配好 Key 了吗」（调用方注入，见 config.cjs）
 */
function canHttp(provider, hasKey) {
  if (!provider || typeof provider !== 'object') return false
  if (isCodexCli(provider)) return false
  if (!String(provider.baseUrl ?? '').trim()) return false
  /* 没注入判据时**保守拒绝** —— 宁可漏掉一个可用后端，也不要拿空 Key 去发请求 */
  return typeof hasKey === 'function' && hasKey(provider) === true
}

module.exports = { OPENAI, CODEX_CLI, KINDS, normalizeKind, isCodexCli, needsKey, canHttp }
