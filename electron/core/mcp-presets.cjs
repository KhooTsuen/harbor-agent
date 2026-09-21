/**
 * MCP 预设 —— 「一键化」的那一半
 *
 * 用户要么自己敲命令行，要么从这几个预设里挑一个。预设负责把「那个服务器的命令
 * 到底怎么写」替你记住，并且把当前工作目录填进去。
 *
 * ── 关于「用内置 Node 跑」──
 *
 * Electron 自带一个 Node（可执行文件加 `ELECTRON_RUN_AS_NODE=1` 就是 node），
 * 所以**你自己写的 JS MCP 服务器不用先装 Node** —— 预设里那一条就是干这个的。
 *
 * 但要说清楚：**`npx` 不在 Electron 里**（它只带 Node，不带 npm）。所以官方那几个
 * 走 `npx -y @modelcontextprotocol/server-*` 的服务器，仍然需要系统装了 Node ——
 * 预设里用 `needs: 'node'` 标出来，界面会提示。
 *
 * ── 关于命令写法 ──
 *
 * 下面这几条按官方参考服务器的 README 写的（渠道：`modelcontextprotocol/servers`）。
 * 上游改过名、也归档过一些服务器 —— **以那个仓库为准**，所以每条都带 `repo`。
 * 预设只是省打字的起点，填进表单之后还能改。
 */

const REPO = 'https://github.com/modelcontextprotocol/servers'

/** `${dir}` 是占位符，界面拿当前工作目录替换（见 fillCommand） */
const PRESETS = [
  {
    id: 'filesystem',
    name: '文件系统（官方参考服务器）',
    description: '让 Agent 通过 MCP 读写你指定的目录 —— 和内置文件工具是两条独立通道',
    command: 'npx -y @modelcontextprotocol/server-filesystem ${dir}',
    needs: 'node',
    repo: REPO,
  },
  {
    id: 'fetch',
    name: '网页抓取（官方参考服务器）',
    description: '抓网页并转成 Markdown 喂给模型',
    command: 'npx -y @modelcontextprotocol/server-fetch',
    needs: 'node',
    repo: REPO,
  },
  {
    id: 'memory',
    name: '知识图谱记忆（官方参考服务器）',
    description: '一个可在多轮之间累积的实体—关系记忆（与本应用自带的记忆是两回事）',
    command: 'npx -y @modelcontextprotocol/server-memory',
    needs: 'node',
    repo: REPO,
  },
  {
    id: 'git',
    name: 'Git 仓库（官方参考服务器）',
    description: '看仓库结构、读提交、看 diff',
    command: 'npx -y @modelcontextprotocol/server-git ${dir}',
    needs: 'node',
    repo: REPO,
  },
  {
    id: 'my-node-server',
    name: '我自己写的 JS 服务器（用内置 Node）',
    description: '指一个 .js 文件就行 —— 用应用自带的 Node 跑，**不用先装 Node**',
    command: 'node ${script}',
    needs: 'bundled-node',
    repo: '',
  },
]

/**
 * 把占位符填成实际值。
 *
 * `dir` 里带空格时必须**加引号** —— 命令行是按空格拆参数的（设置页那条输入框也是），
 * 不加引号的话 `C:\我的 项目` 会被拆成两个参数，服务器直接起不来。
 */
function fillCommand(preset, { dir = '', script = '' } = {}) {
  const quote = (v) => {
    const s = String(v ?? '')
    if (!s) return ''
    return /\s/.test(s) ? `"${s}"` : s
  }
  return String(preset?.command ?? '')
    /* 没配工作目录时给一句人话占位符 —— 显示成 `.` 会让人以为是「当前目录」，其实不是 */
    .replace(/\$\{dir\}/g, quote(dir) || '你的目录')
    .replace(/\$\{script\}/g, quote(script) || '你的服务器.js')
}

function byId(id) {
  return PRESETS.find((p) => p.id === id) ?? null
}

/** 给界面用的纯数据（不含函数） */
function list() {
  return PRESETS.map((p) => ({ ...p }))
}

module.exports = { list, byId, fillCommand, PRESETS }
