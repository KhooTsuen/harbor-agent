/**
 * `messages[]` → **单一 prompt**（纯函数 · 可单测 · 不 require electron）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * Harbor 的模型契约是 OpenAI 风格的 `messages` 数组（system / user / assistant），
 * 而 `codex exec` 只吃**一段初始指令**。所以要拍平，而且拍法要**稳定、可测**。
 *
 * ── ★ 必须如实声明「本次没有工具」────────────────────────────
 *
 * Harbor 每一轮都会带上工具 schema（`tools`），但 codex CLI **不产 `tool_call`**
 * （设计 §2 事实 2、§5.3）。若不在 prompt 里说明，模型会以为自己有工具却调不出来 ——
 * 于是它可能**编造**「我已经读取了那个文件」，而这在 Harbor 里没有发生。
 *
 * 所以：`tools` 非空时，在 prompt 里**明说**没有工具可用、只能文字回答、需要工具时
 * 直接说明。这是「不伪装成完整兼容」（用户 2026-10-17 第 3、9 条）在 prompt 层的落实。
 *
 * ⚠️ 本模块**不 require electron**，也不读磁盘 —— 纯字符串处理，自检直接喂假数据跑。
 */

/** 拼进去时的角色名（中文，与 Harbor 界面一致） */
const ROLE_LABEL = { system: '系统', user: '用户', assistant: '助手' }

/** 「本次没有工具」的声明 —— 只在 Harbor 真的提供了工具时加（见文件头） */
const NO_TOOLS_NOTE = [
  '【关于工具】本次运行**没有可用的工具**：你不能读写文件、不能执行命令、不能访问网页。',
  '请只用文字回答问题。如果这件事必须借助工具才能完成，请**直接说明需要工具**，',
  '不要声称你执行过任何操作。',
].join('\n')

/**
 * ★ MCP 桥启用时的**如实声明**（2026-10-17 真机修的矛盾）。
 *
 * 有 MCP 工具时**不能再写** `NO_TOOLS_NOTE` —— 那会让 Codex 有时信以为真、
 * 回「当前未提供 xxx MCP 工具」（真机复现多次，写入验收因此时灵时不灵）。
 * 但它也**不能说成「你有一堆内置工具」**：这些工具的**执行者是 Harbor 主进程**，
 * 且写类会**先弹给用户审批**（可能被拒）。所以这里三件事都写清楚：
 * 有哪些 · 怎么调 · 调了会发生什么。
 *
 * @param {string[]} names
 */
function mcpToolsNote(names) {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n.trim())
  return [
    '【关于工具】本次运行**有可用的工具** —— 由本机 MCP 服务提供，**执行者是 Harbor 主进程**：',
    ...list.map((n) => `  · ${n}`),
    '要用就**真的调用**它们（通过 MCP），不要只用文字声称你做了。',
    '⚠️ 需要写文件的工具会**先弹给用户确认**，用户可能同意也可能拒绝 —— 被拒就如实说明，不要假装写成功。',
    '⚠️ 你**自己没有** shell / 文件读写能力（沙箱是只读的），一切读写都必须经上面这些工具。',
  ].join('\n')
}

/** 单条消息内容的取法：只认字符串；数组（多模态）取其中的文本片段，其余如实标注 */
function contentOf(message) {
  const content = message && message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = []
    let others = 0
    for (const part of content) {
      if (part && typeof part === 'object' && typeof part.text === 'string') texts.push(part.text)
      else others += 1
    }
    if (others > 0) texts.push(`（另有 ${others} 个非文本内容块，当前后端读不了）`)
    return texts.join('\n')
  }
  return ''
}

/**
 * 拍平成一段 prompt。
 *
 * 结构（有意这么排，见下）：
 *
 *   <system 提示>
 *
 *   【关于工具】…（有工具时才加）
 *
 *   ── 对话历史 ──
 *   用户：…
 *   助手：…
 *
 *   ── 当前请求 ──
 *   <最后一条 user 消息>
 *
 * ★ 为什么把**最后一条 user** 单独拎出来放末尾：codex 是「初始指令」语义，
 *   放在最后 = 最靠近它要做的动作；历史带角色标记，免得它把历史也当成新指令。
 *
 * @param {Array<{role?: string, content?: unknown}>} messages
 * @param {{ tools?: unknown[], mcpTools?: string[], includeNoToolsNote?: boolean }} [opts]
 *        `mcpTools` = **Codex 经 MCP 真能调到的工具名**（见 mcpToolsNote）；非空时
 *        不再写「没有工具」那句，改如实列出。
 * @returns {string}
 */
function buildPrompt(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : []
  const systems = []
  const dialog = []
  for (const message of list) {
    const msg = message && typeof message === 'object' ? message : {}
    const role = String(msg.role ?? '')
    const text = contentOf(msg).trim()
    if (!text) continue
    if (role === 'system') systems.push(text)
    else dialog.push({ role: ROLE_LABEL[role] ?? role ?? '未知', text })
  }

  /* 最后一条对话消息若是「用户」的，拎出来当前请求；否则全部当历史 */
  const last = dialog[dialog.length - 1]
  const isCurrent = last && last.role === ROLE_LABEL.user
  const history = isCurrent ? dialog.slice(0, -1) : dialog

  const blocks = []
  if (systems.length > 0) blocks.push(systems.join('\n\n'))

  /*
   * 工具声明：**三态**，别混。
   *   · 有 MCP 工具（`opts.mcpTools` 非空）→ 如实列出（它们是真能用的）
   *   · 否则 Harbor 带了 tools → 老的「本次没有工具」（纯文本后端的事实）
   *   · 都没有 → 什么也不写（Harbor 本来就没给工具）
   */
  const hasTools = Array.isArray(opts.tools) && opts.tools.length > 0
  const mcpTools = Array.isArray(opts.mcpTools) ? opts.mcpTools.filter(Boolean) : []
  if (mcpTools.length > 0) blocks.push(mcpToolsNote(mcpTools))
  else if (hasTools || opts.includeNoToolsNote === true) blocks.push(NO_TOOLS_NOTE)

  if (history.length > 0) {
    blocks.push(['── 对话历史（以下是已经发生过的对话）──', ...history.map((m) => `${m.role}：${m.text}`)].join('\n'))
  }
  if (isCurrent) {
    blocks.push(['── 当前请求 ──', last.text].join('\n'))
  }

  return blocks.join('\n\n').trim()
}

module.exports = { buildPrompt, contentOf, NO_TOOLS_NOTE, mcpToolsNote, ROLE_LABEL }
