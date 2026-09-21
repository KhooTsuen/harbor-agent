import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   MCP 一键化：预设 + 「用应用自带的 Node 跑」

   要解决的用户摩擦有两处：

     ① 「那个服务器的命令到底怎么写」 —— 预设替用户记住
     ② 「你得先装 Node」 —— 自己写的 JS 服务器可以用**应用自带的 Node**跑
        （Electron 的可执行文件 + `ELECTRON_RUN_AS_NODE=1` 就是 node）

   注意：`npx` 换不动（Electron 只带 Node，不带 npm），预设里标了 `needs: 'node'`——
   这一组会把这个边界也钉住，免得以后有人以为「一键化 = 什么都能不装」。
   ══════════════════════════════════════════════════════════════ */

const presets = require(join(ROOT, 'electron/core/mcp-presets.cjs'))
const runtime = require(join(ROOT, 'electron/core/mcp-runtime.cjs'))
const { fillCommand } = presets

export async function run() {
  const list = presets.list()

  group('MCP 预设 / 结构')
  check('有预设', list.length >= 3, String(list.length))
  check(
    '每条都填齐了',
    list.every((p) => p.id && p.name && p.description && p.command),
    JSON.stringify(list.map((p) => p.id)),
  )
  check('id 不重复', new Set(list.map((p) => p.id)).size === list.length)
  check(
    '每条都标了要不要装 Node',
    list.every((p) => p.needs === 'node' || p.needs === 'bundled-node'),
    JSON.stringify(list.map((p) => `${p.id}:${p.needs}`)),
  )
  check(
    '带占位符的都能填（不留 ${...}）',
    list.every((p) => !fillCommand(p, { dir: 'X:/y', script: 's.js' }).includes('${')),
  )
  check('list() 给的是副本（改了不影响内核那份）', (() => {
    const a = presets.list()
    a[0].name = '篡改'
    return presets.list()[0].name !== '篡改'
  })())

  group('MCP 预设 / 占位符填充')
  const fsPreset = presets.byId('filesystem')
  check('找得到 filesystem 预设', Boolean(fsPreset), String(fsPreset?.id))
  if (fsPreset) {
    const plain = fillCommand(fsPreset, { dir: 'D:\\work' })
    check('★ 工作目录填进去了', plain.includes('D:\\work'), plain)
    check('不带空格时不加引号', !plain.includes('"'), plain)

    const spaced = fillCommand(fsPreset, { dir: 'D:\\我的 项目' })
    check(
      '★ 路径带空格时加引号（否则命令行会被拆成两个参数）',
      spaced.includes('"D:\\我的 项目"'),
      spaced,
    )
  }
  check(
    '★ 没给目录时用人话占位符（显示成 . 会让人误解成「当前目录」）',
    fillCommand(fsPreset, {}).includes('你的目录'),
    fillCommand(fsPreset, {}),
  )
  const ownNode = presets.byId('my-node-server')
  check('★ 有一条是「用内置 Node」的', ownNode?.needs === 'bundled-node', String(ownNode?.needs))
  check(
    '它的命令形如 node <脚本>',
    ownNode ? fillCommand(ownNode, { script: 'D:\\my server.js' }).startsWith('node ') : false,
    ownNode ? fillCommand(ownNode, { script: 'D:\\my server.js' }) : '',
  )

  group('MCP 启动方式 / 用内置 Node')
  const replaced = runtime.resolveSpawn({
    command: 'node',
    args: ['D:\\srv\\server.js', '--flag'],
    useBundledNode: true,
    execPath: 'C:\\Program Files\\Harbor\\Harbor.exe',
  })
  check('★ 换成应用自己的可执行文件', replaced.command === 'C:\\Program Files\\Harbor\\Harbor.exe', replaced.command)
  check('★ 脚本与参数原样带上', replaced.args.join('|') === 'D:\\srv\\server.js|--flag', replaced.args.join('|'))
  check('★ 带上 ELECTRON_RUN_AS_NODE=1', replaced.env.ELECTRON_RUN_AS_NODE === '1')
  check('★ 这条不走 shell（可执行文件路径带空格也不会被拆碎）', replaced.shell === false)
  check('标记了确实换过', replaced.replaced === true)

  const npxKept = runtime.resolveSpawn({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\data'],
    useBundledNode: true,
  })
  check(
    '★ npx 换不动、原样放行（Electron 不带 npm）',
    npxKept.command === 'npx' && npxKept.replaced === false,
    npxKept.command,
  )

  const offByDefault = runtime.resolveSpawn({ command: 'node', args: ['a.js'] })
  check('没开这个开关时什么都不动', offByDefault.replaced === false && offByDefault.command === 'node')
  check(
    '默认走 shell（Windows 上 npx.cmd 要靠它才找得到）',
    offByDefault.shell === (process.platform === 'win32'),
    String(offByDefault.shell),
  )

  const noScript = runtime.resolveSpawn({ command: 'node', args: [], useBundledNode: true })
  check('只有 node 没有脚本时原样放行（报错信息更清楚）', noScript.replaced === false && noScript.command === 'node')

  const pythonKept = runtime.resolveSpawn({ command: 'python', args: ['s.py'], useBundledNode: true })
  check('python 不归它管', pythonKept.replaced === false)

  group('MCP 一键化 / 接线')
  const channels = readFileSync(join(ROOT, 'electron/ipc-channels.cjs'), 'utf8')
  check('★ 通道清单里有 mcp:presets', channels.includes("'mcp:presets'"))
  const preload = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  check('preload 暴露了 mcpPresets', preload.includes('mcpPresets:'))
  const extras = readFileSync(join(ROOT, 'electron/handlers/extras.cjs'), 'utf8')
  check('★ handler 里把占位符填好再给界面', extras.includes('mcpPresets.fillCommand('))
  const conn = readFileSync(join(ROOT, 'electron/core/mcp-connection.cjs'), 'utf8')
  check('★ 连接层用了 resolveSpawn', conn.includes('mcpRuntime.resolveSpawn('))
  check('★ 解析出来的 env 并进了白名单 env（没被丢掉）', conn.includes('...resolved.env'))
  const norm = readFileSync(join(ROOT, 'electron/core/config-normalize.cjs'), 'utf8')
  check('配置里认 useBundledNode 这个字段', norm.includes('useBundledNode'))
  const tab = readFileSync(join(ROOT, 'src/components/settings/tabs/McpTab.tsx'), 'utf8')
  check('★ 设置页会渲染预设', tab.includes('mcpPresets()') && tab.includes('preset.command'))
  check('界面区分「要不要装 Node」', tab.includes('bundled-node'))
}
