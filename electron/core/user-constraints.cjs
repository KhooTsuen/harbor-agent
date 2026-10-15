/**
 * 用户这轮说的运行时约束（「只分析，不修改」这类）
 *
 * 为什么单独立一个文件：
 *   · 判据是**正则启发式**。启发式只有能被直接调用才钉得住 —— 原来它内联在
 *     `loop.cjs` 造 ctx 的那一段里，自检碰不到（2026-10-15 那次误判就是这么漏过去的）。
 *   · 「用户这一轮说了什么」本来就是一件事，抠法该只有一处（硬约束 9）。
 *
 * ★ 2026-10-15 修掉的误判（用户报「内置浏览器调不动」）
 *
 *   原来是 `/(只分析|不要修改|禁止修改|不许写|不要写文件|不执行修改)/` —— 其中
 *   **`不许写` 太泛**：用户给模型的**输出要求**「凡是你没能在网页上核实的，
 *   一律标注『未验证』，**不许写成确定的事实**」里就带着它，于是整整一轮
 *   `allowWrite=false`，`browse` / `run_shell` / `write_file` 全被拒
 *   （装机版 errors/2026-10-15.jsonl 16:46–16:49 六条全是这个）。
 *
 *   现在拆成两半，**任一半命中才算「别动东西」**：
 *
 *     ① **明确短语**：语义本来就指向「别动东西」，不需要宾语。
 *        例：「只分析」「不执行修改」—— 只有一种解释，不需要宾语。
 *
 *     ② **否定词 + 泛动词 + 文件类对象**：`不许写` / `不要改` 这类泛动词
 *        必须和**宾语**同现才算。「不许写**成**确定的事实」被两道挡下 ——
 *        `(?!成)`（挡「写成…」这种输出要求的固定搭配）+ 后面 12 字内没有
 *        文件类对象（挡「写成…的事实」）。
 *
 *   代价是明确写下的：**光说「不许写」而没说写什么，不再算约束**。
 *   这比反过来（把「不许写成事实」当成禁写）安全得多 —— 后者会让整轮工具不可用。
 */

/* ── ① 明确短语（语义自足，不需要宾语）──────────────────────
 *
 * 只放**只有一种解释**的：「只分析」「不执行修改」。
 * 「不要修改」「禁止修改」**不在这里** —— 它们配上非文件宾语（「不要修改结论」）
 * 就是输出要求，挪到 ② 去要求带宾语（2026-10-15 实测：「不要修改结论」曾被误判）。
 */

const NO_WRITE_PHRASE = /(只分析|不执行修改)/

/* ── ② 泛动词 + 文件类对象（必须同现）────────────────────────
 *
 * `(?!成)` 挡的是「写成/改成」这类**输出要求**的固定搭配：
 *   「不许写成确定的事实」「不要写成代码」都不该算「别动文件」。
 * 窗口 `{0,12}` 且不跨句末标点 —— 免得隔了半句话的两个词凑成一次命中。
 *
 * ★ 宾语清单**只收具体对象**（文件 / 代码 / 仓库…）。「东西」这类泛名词
 *   收过一次又删了：它会把「不要写，先讲清楚这个东西」误判成禁写 ——
 *   宾语越泛，误判越多，而漏判（罕见说法没拦住）最多只是那一轮没生效。
 */
const NO_WRITE_VERB_OBJECT =
  /(不许|不要|不准|严禁|禁止|不能|别|切勿|不)(再|去|自己|乱|随便)?(写|改|改动|修改|动|碰|删|删除|覆盖)(?!成)[^。！？；\n]{0,12}(文件|代码|脚本|配置|仓库|目录|磁盘|硬盘|项目|数据库|落盘|产物)/

/* ── 联网（判据保持原样，只是搬了个家）──────────────────────── */

const NO_NETWORK_PHRASE = /(不联网|不要联网|禁止联网|离线)/

/**
 * 这轮算不算「别动东西」。
 *
 * @param {string} [userText] 历史里最后一条用户消息的原文（`loop-route.lastUserText`）
 * @returns {boolean}
 */
function noWriteIn(userText) {
  const text = typeof userText === 'string' ? userText : ''
  return NO_WRITE_PHRASE.test(text) || NO_WRITE_VERB_OBJECT.test(text)
}

/**
 * 这轮算不算「别联网」。
 *
 * @param {string} [userText]
 * @returns {boolean}
 */
function noNetworkIn(userText) {
  const text = typeof userText === 'string' ? userText : ''
  return NO_NETWORK_PHRASE.test(text)
}

/**
 * 这轮允许写 / 改东西吗。
 *
 * 显式设置（`threadSettings.allowWrite`，会话级开关）**优先于**文本启发式：
 * 用户/界面明确关了就是关了；明确开着（undefined 也算没关）再看他说了什么。
 * `mode === 'plan'` 是既有的硬规则（计划模式不落地改动）。
 *
 * @param {{ userText?: string, mode?: string, threadAllowWrite?: boolean }} input
 * @returns {boolean}
 */
function allowsWrite(input = {}) {
  const { userText = '', mode = '', threadAllowWrite } = input
  if (threadAllowWrite === false) return false
  if (mode === 'plan') return false
  return !noWriteIn(userText)
}

/**
 * 这轮允许联网吗。
 *
 * @param {{ userText?: string, threadAllowNetwork?: boolean }} input
 * @returns {boolean}
 */
function allowsNetwork(input = {}) {
  const { userText = '', threadAllowNetwork } = input
  if (threadAllowNetwork === false) return false
  return !noNetworkIn(userText)
}

module.exports = {
  NO_WRITE_PHRASE,
  NO_WRITE_VERB_OBJECT,
  NO_NETWORK_PHRASE,
  noWriteIn,
  noNetworkIn,
  allowsWrite,
  allowsNetwork,
}
