/**
 * 自检 / 项目规则的应用内编辑（真机反馈 10）
 *
 * 从 `97-project-rules.mjs` 分出来的：那边本来就在 300 行边上（硬约束 #2），
 * 而这一块自己就完整 —— **跑的是真的 handler**，不是看源码。
 *
 * 最要紧的判据是「往工作目录外面写」必须**做不到**：
 *   接口收的是符号（`rules` / `agent`），文件路径由内核自己拼，
 *   所以给它一个 `../../evil.md` 只会得到「不认识的编辑目标」，磁盘上也不会多出文件。
 */
import {
  join,
  readFileSync,
  require,
  ROOT,
  SANDBOX,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from '../env.mjs'
import { check, group } from '../harness.mjs'

const rulesCore = require(join(ROOT, 'electron/core/project-rules.cjs'))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const DIR = join(SANDBOX, '.harbor')
const MAIN = join(DIR, 'rules.md')

function reset() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(join(SANDBOX, 'AGENT.md'), { force: true })
  rulesCore.invalidate(SANDBOX)
}

export async function run() {
  group('项目规则 / 应用内编辑（真机反馈 10）')

  /* 注册时收一个假的 ipcMain，把 handle 的登记表抓下来 */
  const registered = {}
  require(join(ROOT, 'electron/handlers/project-rules.cjs')).register({
    ipcMain: {
      handle: (name, fn) => {
        registered[name] = fn
      },
    },
  })

  reset()
  mkdirSync(SANDBOX, { recursive: true })
  writeFileSync(join(SANDBOX, 'AGENT.md'), '# AGENT 演示\n', 'utf8')

  const writeFileApi = registered['projectRules:writeFile']
  const readFileApi = registered['projectRules:readFile']
  check(
    '两条编辑通道都注册上了',
    typeof writeFileApi === 'function' && typeof readFileApi === 'function',
    Object.keys(registered).join(','),
  )

  const saved = writeFileApi(null, { dir: SANDBOX, target: 'rules', content: '# 应用内写的规则\n' })
  check(
    '★ 应用内保存 → 文件真的落盘、内容对得上',
    saved?.ok === true && readFileSync(MAIN, 'utf8').includes('应用内写的规则'),
    JSON.stringify(saved),
  )
  check(
    '★ 保存后立即生效（不等 mtime、也不用再点一次重新加载）',
    rulesCore.buildPromptSection({ workdir: SANDBOX }).includes('应用内写的规则'),
    '规则段里没看到刚写的内容',
  )

  const agentRead = readFileApi(null, { dir: SANDBOX, target: 'agent' })
  check(
    '第二份（AGENT.md）也能读回',
    agentRead?.ok === true && String(agentRead.content).includes('AGENT 演示'),
    JSON.stringify(agentRead).slice(0, 120),
  )

  const evil = writeFileApi(null, { dir: SANDBOX, target: '../../evil.md', content: 'x' })
  check(
    '★ 拿路径当目标 → 被拒（接口只认符号，路径由内核拼）',
    evil?.ok === false && !existsSync(join(SANDBOX, '..', '..', 'evil.md')),
    JSON.stringify(evil).slice(0, 120),
  )
  const noTarget = writeFileApi(null, { dir: SANDBOX, content: 'x' })
  check('不传目标 → 也拒（不会默认往某个文件写）', noTarget?.ok === false, JSON.stringify(noTarget).slice(0, 80))

  const tooBig = writeFileApi(null, {
    dir: SANDBOX,
    target: 'rules',
    content: 'x'.repeat(600 * 1024),
  })
  check(
    '★ 超过编辑上限 → 拒，且没有把原文件写坏',
    tooBig?.ok === false && readFileSync(MAIN, 'utf8').includes('应用内写的规则'),
    JSON.stringify(tooBig).slice(0, 120),
  )

  const handlerSrc = read('electron/handlers/project-rules.cjs')
  check(
    '★ 保存动作进审计（tool=edit_project_rules）',
    handlerSrc.includes("tool: 'edit_project_rules'") && handlerSrc.includes('affectedFiles: [file]'),
    '没找到审计调用',
  )

  const channels = read('electron/ipc-channels.cjs')
  check(
    '★ 通道清单与 preload 都补了（漏了打包时报 channelsMissing）',
    ['projectRules:readFile', 'projectRules:writeFile'].every((c) => channels.includes(`'${c}'`)) &&
      ['projectRulesReadFile', 'projectRulesWriteFile'].every((m) =>
        read('electron/preload.cjs').includes(`${m}:`),
      ),
    '清单或 preload 少了新通道',
  )
  check(
    '★ 设置页那一行有应用内编辑入口（RulesEditor 真的被渲染）',
    read('src/components/settings/tabs/ProjectRulesRow.tsx').includes('<RulesEditor') &&
      read('src/components/settings/tabs/RulesEditor.tsx').includes('projectRulesWriteFile'),
    '那一行没接上编辑器',
  )

  reset()
}
