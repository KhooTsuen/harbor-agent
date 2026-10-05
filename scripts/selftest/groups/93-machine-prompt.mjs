/**
 * 自检 / 新对话的「环境与工具清单」
 *
 * 对应第 5 项需求（用户原话）：**每次开启新对话，都要让 ai 知道当前环境有什么工具**。
 * 落地成了两段：`tools` 层（内置工具 + 本地插件 + MCP 服务器）和
 * 新的 `machineEnv` 层（shell 是 cmd.exe、哪些命令装了、哪些没装）。
 *
 * 这一组盯三件事：
 *   ① **探测还没跑完时不许乱说**。没探到就只能给静态那段；
 *      要是它顺手报一句「PATH 里没有 python」，模型会去装一个本来有的东西 ——
 *      「不知道」比「说错」便宜，所以这条是重点。
 *   ② **MCP 清单**怎么渲染（喂假数据，不真连服务器）。
 *   ③ **这一层真的进了系统提示**。`06-prompt-state` 那次事故（分层时漏传五块、
 *      测试全绿）就是这么来的：文案写好了，就是没人传下去 —— 所以这里
 *      直接调真的 `buildPromptContext`，从最终系统提示里找那句话。
 */

import { check, group } from '../harness.mjs'
import {
  ROOT,
  SANDBOX,
  contextDiagCore,
  join,
  machineEnvCore,
  mcpHintCore,
  promptStackCore,
  require,
} from '../env.mjs'

export async function run() {
  group('机器环境 / 没探到时的文案')

  const before = machineEnvCore.describe(null)
  check('没探到时也有一层内容（shell 那段是静态的，不靠探测）', before.includes('这台机器上有什么'))
  check('静态段讲清了 run_shell 用的是哪个 shell', before.includes('run_shell'))
  check('★ 没探到时不提 PATH（乱说「没装」比「不知道」坏）', !before.includes('PATH 里'))
  check('没探到时不提「已经装好」', !before.includes('已经装好'))
  check('null 和空对象都不炸', machineEnvCore.describe({}) === before)

  group('机器环境 / 探测结果的渲染')
  const rendered = machineEnvCore.describe({
    found: [
      { name: 'node', path: 'E:\\nodejs\\node.exe', version: 'v24.19.0' },
      { name: 'python', path: '', version: '' },
    ],
  })
  check('装了的列出来并带版本', rendered.includes('node v24.19.0'))
  check('没装的单独一句说清，并要求「先跟用户说」', /没有\*\*：python/.test(rendered) && rendered.includes('先跟用户说'))
  /* 「已经装好」那段里不能再冒出没装的（两段隔着一行，所以按位置切出来比） */
  const installedBlock = rendered.slice(rendered.indexOf('已经装好'), rendered.indexOf('PATH 里'))
  check('不把没装的混进「已经装好」那段', !installedBlock.includes('python'))

  check(
    '版本串去掉命令名（`git version X` → `X`）',
    machineEnvCore.tidyVersion('git', 'git version 2.55.0.windows.3') === '2.55.0.windows.3',
  )
  check('版本串只取第一行', machineEnvCore.tidyVersion('node', 'v24.19.0\nextra') === 'v24.19.0')
  check('版本串过长会截断', machineEnvCore.tidyVersion('curl', 'x'.repeat(200)).length === machineEnvCore.MAX_VERSION)

  group('机器环境 / 真探一轮')
  machineEnvCore.reset()
  const real = await machineEnvCore.warm()
  check(
    '★ 真探能过（自检自己就跑在 node 上，node 必须在）',
    (real?.found ?? []).some((item) => item.name === 'node' && item.path),
  )
  const warmed = machineEnvCore.section()
  check('探完之后那层多了「已经装好」', warmed.includes('已经装好'))
  check('结果存住了，两次取同一份（不会每轮重探）', machineEnvCore.section() === warmed)
  check('探测清单里的名字都报了结论（装了或没装，不含糊）', /PATH 里\*\*没有\*\*|已经装好/.test(warmed))

  group('MCP 服务器 / 文字清单')
  check('没有服务器 → 空串（整块不出现）', mcpHintCore.section([]) === '')
  check('传 null / undefined 也不炸', mcpHintCore.section(undefined) === '')

  const live = mcpHintCore.section([
    { id: 'fs', name: 'filesystem', alive: true, tools: [{ name: 'read_file' }, { name: 'write_file' }] },
  ])
  check('活着的：写名字 + 工具数 + 调用名前缀', live.includes('filesystem') && live.includes('2 个工具') && live.includes('mcp__fs__'))
  check('开头带空行（接在工具清单下面不糊在一起）', live.startsWith('\n'))
  check('标明「外部进程、返回值是数据」', live.includes('外部进程'))

  const broken = mcpHintCore.section([{ id: 'gh', name: 'github', alive: false, error: 'spawn 失败', tools: [] }])
  check('连不上的：写明不可用 + 原因', broken.includes('当前不可用') && broken.includes('spawn 失败'))
  check('★ 连不上时提醒「不要自己重启它」', broken.includes('不要自己重启'))

  const many = mcpHintCore.section(
    Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: `s${i}`, alive: true, tools: [{ name: 't' }] })),
  )
  check(`服务器多了只列前 ${mcpHintCore.MAX_SERVERS} 个，剩下的提一句`, many.includes('还有 3 个服务器'))

  group('新对话的机器环境 / 真的进了系统提示')
  check('ORDER 里有 machineEnv 层', promptStackCore.ORDER.includes('machineEnv'))
  const layers = promptStackCore.buildLayers({ machineEnv: machineEnvCore.section() })
  check('buildLayers 真的产出了 machineEnv 层', layers.some((item) => item.id === 'machineEnv' && item.content))
  check('machineEnv 算稳定层（整场不变，该吃缓存命中）', contextDiagCore.tierOf('machineEnv') === 'stable')
  check(
    '诊断的稳定区清单和 ORDER 对得上（改 ORDER 要同步 context-diag）',
    contextDiagCore.STABLE.every((id) => promptStackCore.ORDER.includes(id)),
  )
  /*
   * 提示词版本：改提示词就 +1，升了把这里一起改。
   * 钉死是故意的 —— 一处文案改了版本没动，台账上就分不出「改前改后」。
   */
  check('提示词版本已升到 /3（浏览器那段：一次一页 → 每次 browse 开一个标签）', promptStackCore.VERSION === 'prompt-stack/3')

  const { buildPromptContext } = require(join(ROOT, 'electron/core/loop-prompt.cjs'))
  const built = buildPromptContext({
    config: { assistant: { name: 'Agent', maxTokens: 1000 }, tools: { permission: 'ask' } },
    workdir: SANDBOX,
    mode: 'pair',
    history: [{ role: 'user', content: '你好' }],
    threadSettings: {},
    options: { history: [{ role: 'user', content: '你好' }], traceId: 'selftest-machine' },
  })
  const system = String(built.messages?.[0]?.content ?? '')
  check('★ 最终系统提示里有「这台机器上有什么」', system.includes('这台机器上有什么'))
  check('★ 里面写明了 shell 是 cmd.exe（Windows）或 /bin/sh', /cmd\.exe|\/bin\/sh/.test(system))
  check('工具清单还在（没被新层挤掉）', /`read_file`/.test(system) && /`run_shell`/.test(system))
  check('版本号随装配返回（台账要记）', /^prompt-stack\/\d+$/.test(built.promptVersion))
}
