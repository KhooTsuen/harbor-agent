/**
 * Codex CLI 后端的**预设**（2026-10-17）
 *
 * 为什么单独一个文件：`config-defaults.cjs` 已 298 行贴着 300 红线，而这条预设
 * 连注释要十几行。做法与 `clarify-config.cjs` / `scale-config.cjs` 一致
 * （那两个也是把自己的 DEFAULTS 外置，defaults 那边只 require 进来）。
 *
 * ── ★ 为什么默认 `enabled: false` ───────────────────────────────
 *
 * 它是**实验性**后端：只有纯文本，**没有 Harbor 原生工具调用**（见设计文档 §4）。
 * 默认关着 —— 不启用就对任何人零影响，DeepSeek 仍是默认后端。
 *
 * ── ★ 为什么没有 apiKey / baseUrl ──────────────────────────────
 *
 * 推理走**本机已登录的 ChatGPT Codex CLI**（`codex exec --json`），凭据由 CLI 自己
 * 管（`~/.codex/`）—— **Harbor 一个字节都不碰**（用户 2026-10-17 明令：不得把
 * ChatGPT 登录凭据复制进 Harbor 配置）。所以 `credentialRef` 为空：
 * 这个后端**不需要 API Key**，也因此需要选择链路放行（见设计 §5.1）。
 *
 * 完整设计见 `docs/research/codex-cli-adapter-design.md`。
 *
 * ⚠️ 这条只进**默认列表**：已有用户的 `config.json` 里已经有 providers 数组，
 *    `config-normalize.cjs` 会原样用用户的（不会补默认）—— 那类用户从设置界面
 *    的「添加 Codex CLI 后端」入口添加（见阶段 E）。
 */

const CODEX_CLI_PROVIDER = {
  id: 'codex-cli',
  name: 'ChatGPT Codex CLI（实验性）',
  /**
   * 后端种类 —— 决定「怎么调这个模型」：
   *   `'openai'`（HTTP/SSE，`llm.cjs`）/ `'codex-cli'`（子进程 + JSONL，`codex-cli.cjs`）
   * ★ 传输方式与**模型能力**分开声明（能力见 `provider-capabilities.cjs`）。
   */
  kind: 'codex-cli',
  /* 走 CLI、不走 HTTP —— 两个都空是**有意的**，不是漏填 */
  baseUrl: '',
  credentialRef: '',
  /**
   * 模型标识。★ 它**不是**发给上游的模型名：适配器默认不传 `-m`，让 codex 用它
   * 自己 `config.toml` 里配的模型（本机实测是 `gpt-6.1-sol`）。这个字符串的作用
   * 只是「在 Harbor 里有个名字可以选、可以路由」。
   */
  models: ['codex-cli'],
  enabled: false,
  extraBody: {},
  omitParams: [],
  streamUsage: false,
}

module.exports = { CODEX_CLI_PROVIDER }
