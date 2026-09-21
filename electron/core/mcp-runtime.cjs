/**
 * MCP 服务器的「到底怎么起」—— 纯函数，专门为了能测
 *
 * 只有一件事需要判断：**用不用应用自带的那个 Node**。
 *
 * Electron 的可执行文件加上 `ELECTRON_RUN_AS_NODE=1` 就是一个标准的 node
 * （不带 Electron API，也不带 npm）。所以：
 *
 *   · 用户自己写的 JS 服务器 → 可以指一个 .js 文件，**不必先装 Node**
 *   · 走 `npx -y @modelcontextprotocol/server-*` 的 → 仍然需要系统装 Node
 *     （`npx` 是 npm 的东西，Electron 不带）
 *
 * ── 为什么换掉之后要把 shell 关掉 ──
 *
 * 原来一律 `shell: true`（Windows 上走 cmd.exe，这样 `npx` 这种 .cmd 才找得到）。
 * 但换成自带 Node 之后，命令变成了**应用自己的可执行文件路径**，
 * 而这个路径很可能带空格（比如 `C:\Program Files\...`、或者中文+空格的便携目录）——
 * `shell: true` 时 Node 只是把命令和参数用空格拼起来，**不加引号**，
 * 于是一条好好的启动命令会被拆碎（和路径边界那里踩的是同一个坑）。
 * 所以这条路直接 `shell: false` 起进程，不经过 cmd.exe。
 */

/** 这些都不是我们能用自带 Node 顶替的东西（npx/npm 依赖 npm 安装树） */
const NOT_REPLACEABLE = new Set(['npx', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'uvx', 'docker'])

function baseName(command) {
  return String(command ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '')
}

/**
 * 解析出真正要 spawn 的东西。
 *
 * @returns {{command: string, args: string[], env: Record<string,string>, shell: boolean, replaced: boolean}}
 */
function resolveSpawn({
  command,
  args = [],
  useBundledNode = false,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  const cmd = String(command ?? '').trim()
  const list = (Array.isArray(args) ? args : []).map(String)
  /* 不走 shell 的场景：命令本身是个真实可执行文件（下面是唯一那种情况） */
  const shellDefault = platform === 'win32'

  if (!useBundledNode) {
    return { command: cmd, args: list, env: {}, shell: shellDefault, replaced: false }
  }

  /* 只有「用 node 跑一个脚本」才换得动；别的类型原样放行，让用户自己负责 */
  if (baseName(cmd) !== 'node' || NOT_REPLACEABLE.has(baseName(cmd))) {
    return { command: cmd, args: list, env: {}, shell: shellDefault, replaced: false }
  }

  const script = list[0]
  if (!script) {
    /* `node` 后面没跟脚本：换过去只会立刻报错，不如原样交给系统 node（报错信息也更清楚） */
    return { command: cmd, args: list, env: {}, shell: shellDefault, replaced: false }
  }

  return {
    command: execPath,
    args: [script, ...list.slice(1)],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    /* 换成真实可执行文件之后不需要 shell，而且能避开「路径带空格被拆碎」 */
    shell: false,
    replaced: true,
  }
}

module.exports = { resolveSpawn, NOT_REPLACEABLE }
