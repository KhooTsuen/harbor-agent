/**
 * Provider 能力：**内置预设表**（声明，不是探测）
 *
 * ⚠️ 这里每一行都是从各家公开文档抄下来的**声明**，没有一条是探测结果。
 *    要真的知道某家中转站背后的模型支不支持 tool_call / 图片，得发真实请求去试，
 *    那需要联网 —— 而本项目的内核自检**不联网**（见 AGENT.md），所以这一轮不做探测。
 *
 * 因此这张表遵守两条规矩：
 *   ① **不确定的一律省略**（省略 = 未知，不是「不支持」）。宁可说「不知道」，
 *      也不要猜一个 true/false —— 猜错的后果是用户在设置里看到一句肯定的假话。
 *   ② 每条都留 `note`，写明依据。上游改名/改版本会让预设过期，
 *      用户得有个地方能看出「这个结论是哪来的」。
 *
 * 匹配顺序有意义：**先具体后笼统**（gpt-4o-mini 排在 gpt-4o 前面，
 * 否则 mini 会被 4o 的规则吃掉）。用户手填的覆盖永远优先于这张表
 * （见 provider-capabilities.cjs 的 resolve）。
 *
 * 只放数据，不放逻辑 —— 和 config-defaults.cjs 一样。
 */

/* ── 复用的碎片：这几个组合在下面反复出现，写一处免得抄错 ── */

/** OpenAI 系对话模型：工具调用 + 结构化输出 + 附件 */
const OPENAI = { chat: true, streaming: true, tool_call: true, structured_output: true, attachments: true }

/** Claude 系：工具调用很强，但没有 OpenAI 那种 JSON schema 强约束（未知） */
const CLAUDE = { chat: true, streaming: true, tool_call: true, attachments: true }

/** Gemini 系 */
const GEMINI = { chat: true, streaming: true, tool_call: true, structured_output: true }

/** 文本 + 工具，没有视觉 */
const TEXT_TOOLS = { chat: true, streaming: true, tool_call: true, vision: false, attachments: false }

/** **不是对话模型** —— 这条最有用：拿它去聊天会 400/404，而用户很难自己看出来 */
const NOT_CHAT = {
  chat: false,
  streaming: false,
  tool_call: false,
  vision: false,
  structured_output: false,
  reasoning: false,
  attachments: false,
  search: false,
}

/**
 * 预设表。`test` 匹配的是**归一化后**的模型名（小写、去掉 `vendor/` 前缀、去掉 `:tag`），
 * 见下面的 normalizeName。
 */
const PRESETS = [
  /* ── 不是对话模型（放最前面，免得被后面的宽规则接走） ── */
  { id: 'non-chat-embedding', test: /embedding|^bge-|^text-similarity|^rerank/, caps: NOT_CHAT,
    note: '向量/重排模型，不在 /chat/completions 上' },
  { id: 'non-chat-media', test: /^(whisper|tts-|dall-e|gpt-image|sd-|stable-diffusion|flux)/, caps: NOT_CHAT,
    note: '音频/图像专用接口，不走对话接口' },

  /* ── OpenAI ── */
  { id: 'openai-o1-early', test: /^o1-(preview|mini)/,
    caps: { chat: true, streaming: false, tool_call: false, vision: false, structured_output: false,
      reasoning: true, attachments: false, context_window: 128_000 },
    note: 'OpenAI 文档：o1-preview / o1-mini 不支持流式、不支持 function calling' },
  { id: 'openai-o3-mini', test: /^o3-mini/,
    caps: { ...OPENAI, vision: false, reasoning: true, context_window: 200_000 },
    note: 'o3-mini：支持工具调用与流式；不接受图片' },
  { id: 'openai-gpt-4o-mini', test: /^gpt-4o-mini/,
    caps: { ...OPENAI, vision: true, context_window: 128_000, max_output: 16_384 },
    note: 'OpenAI 文档：4o-mini 支持图片与 JSON schema' },
  { id: 'openai-gpt-4o', test: /^gpt-4o/,
    caps: { ...OPENAI, vision: true, context_window: 128_000, max_output: 16_384 },
    note: 'OpenAI 文档：4o 支持图片与 JSON schema' },
  { id: 'openai-gpt-4.1', test: /^gpt-4\.1/,
    caps: { ...OPENAI, vision: true, context_window: 1_047_576, max_output: 32_768 },
    note: 'OpenAI 文档：4.1 约 100 万上下文' },
  { id: 'openai-gpt-4-turbo', test: /^gpt-4-turbo|^gpt-4-(0125|1106)/,
    caps: { ...OPENAI, vision: true, context_window: 128_000, max_output: 4_096 },
    note: 'OpenAI 文档：4-turbo 支持图片' },
  { id: 'openai-gpt-4', test: /^gpt-4/,
    caps: { ...OPENAI, vision: false, context_window: 8_192, max_output: 8_192 },
    note: '初代 gpt-4：纯文本；上下文按官方旧值 8K 记' },
  { id: 'openai-gpt-3.5', test: /^gpt-3\.5/,
    caps: { ...OPENAI, vision: false, context_window: 16_385, max_output: 4_096 },
    note: 'OpenAI 文档：gpt-3.5-turbo 纯文本、支持工具调用' },

  /* ── Anthropic ── */
  { id: 'anthropic-claude-3.5', test: /^claude-3[-.]5/,
    caps: { ...CLAUDE, vision: true, context_window: 200_000, max_output: 8_192 },
    note: 'Anthropic 文档：200K 上下文、支持图片与工具' },
  { id: 'anthropic-claude-3', test: /^claude-3/,
    caps: { ...CLAUDE, vision: true, context_window: 200_000, max_output: 4_096 },
    note: 'Anthropic 文档：claude-3 系 200K 上下文、支持图片' },
  { id: 'anthropic-claude-4', test: /^claude-(opus|sonnet|haiku)-4|^claude-4/,
    caps: { ...CLAUDE, vision: true, reasoning: true, context_window: 200_000, max_output: 32_000 },
    note: 'Claude 4 系：支持扩展思考；输出上限按官方保守值记' },
  { id: 'anthropic-claude-2', test: /^claude-2/,
    caps: { chat: true, streaming: true, tool_call: false, vision: false, context_window: 100_000 },
    note: 'claude-2 系：无图片、无工具调用' },

  /* ── DeepSeek（默认供应商，最要紧的一家） ── */
  { id: 'deepseek-reasoner', test: /^deepseek-(reasoner|r1)/,
    caps: { chat: true, streaming: true, tool_call: false, vision: false, structured_output: false,
      reasoning: true, attachments: false, context_window: 65_536 },
    note: 'DeepSeek 文档：reasoner/R1 不支持 function calling 与 JSON 输出；上下文 64K' },
  { id: 'deepseek-vl', test: /^deepseek.*vl/,
    caps: { chat: true, streaming: true, vision: true },
    note: 'DeepSeek-VL 系：能读图；工具调用没查到明确说法，留成未知' },
  { id: 'deepseek-chat', test: /^deepseek/,
    caps: { chat: true, streaming: true, tool_call: true, vision: false, structured_output: true,
      attachments: false, context_window: 65_536, max_output: 8_192 },
    note: 'DeepSeek 官方 deepseek-chat 保守值（64K）；V3.1 之后可能已放宽，以官方为准' },

  /* ── Google ── */
  { id: 'google-gemini-2.5', test: /gemini-2\.5/,
    caps: { ...GEMINI, vision: true, reasoning: true, context_window: 1_048_576 },
    note: 'Gemini 2.5：支持 thinking；上下文 1M' },
  { id: 'google-gemini-1.5-2.0', test: /gemini-(1\.5|2\.0|2)/,
    caps: { ...GEMINI, vision: true, context_window: 1_048_576 },
    note: 'Gemini 1.5/2.0：1M 上下文、支持图片与工具' },

  /* ── 国内常见 ── */
  { id: 'qwen-vl', test: /^qwen.*vl|[-_.]vl/,
    caps: { chat: true, streaming: true, vision: true },
    note: 'Qwen-VL 系：能读图；文档没提 function calling，留成未知' },
  { id: 'qwen3', test: /^qwen3/,
    caps: { chat: true, streaming: true, tool_call: true, vision: false, reasoning: true },
    note: 'Qwen3 混合推理：走硅基流动一类中转要用 extraBody 显式开关 thinking' },
  { id: 'qwen-family', test: /^qwen/, caps: TEXT_TOOLS,
    note: 'Qwen 文本系（max/plus/turbo/2.5）：支持工具调用，纯文本' },
  { id: 'glm-vision', test: /^glm.*v/,
    caps: { chat: true, streaming: true, vision: true },
    note: 'GLM-V 系：能读图' },
  { id: 'glm-family', test: /^glm/, caps: TEXT_TOOLS,
    note: 'GLM-4 系：支持工具调用，纯文本' },
  { id: 'moonshot', test: /^(kimi|moonshot)/, caps: TEXT_TOOLS,
    note: 'kimi / moonshot-v1：文本模型' },

  /* ── 开源系 ── */
  { id: 'meta-llama-vision', test: /llama.*vision/,
    caps: { chat: true, streaming: true, vision: true, context_window: 128_000 },
    note: 'Llama 3.2 Vision：能读图；工具调用没查到权威说法，留成未知' },
  { id: 'meta-llama-3-4', test: /llama-?(3\.[123]|4)/,
    caps: { ...TEXT_TOOLS, context_window: 128_000 },
    note: 'Llama 3.1 起支持工具调用；128K 上下文' },
  { id: 'mistral', test: /^(mistral|mixtral|magistral)/, caps: TEXT_TOOLS,
    note: 'Mistral 系：支持工具调用；具体上下文容量没写死，留成未知' },
  { id: 'xai-grok-vision', test: /grok.*vision/,
    caps: { chat: true, streaming: true, vision: true, tool_call: true },
    note: 'grok-2-vision 一类：能读图、支持工具' },
  { id: 'xai-grok', test: /^grok/, caps: TEXT_TOOLS,
    note: 'Grok 系文本模型：支持工具调用' },
]

/**
 * 模型名归一化：各家写法不一样，不归一就匹配不上。
 *
 *   `deepseek/deepseek-chat`  → deepseek-chat   （OpenRouter 的 vendor 前缀）
 *   `llama3.1:8b`             → llama3.1        （Ollama 的 tag）
 *   `qwen3-235b-a22b:free`    → qwen3-235b-a22b （OpenRouter 的免费后缀）
 */
function normalizeName(model) {
  const raw = String(model ?? '').trim().toLowerCase()
  if (!raw) return ''
  const noVendor = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  return noVendor.split(':')[0].trim()
}

/** 命中哪条预设；**没命中返回 null**（不给它编一个默认能力） */
function match(model) {
  const name = normalizeName(model)
  if (!name) return null
  return PRESETS.find((p) => p.test.test(name)) ?? null
}

/** 给测试和界面用的副本（改了不影响内核这份） */
function list() {
  return PRESETS.map((p) => ({ ...p, caps: { ...p.caps } }))
}

module.exports = { PRESETS, normalizeName, match, list }
