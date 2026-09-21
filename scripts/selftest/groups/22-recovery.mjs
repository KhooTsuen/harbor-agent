import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-012：任务持久化与重启恢复

   文档要求存下来：goal / plan / currentStep / completedSteps /
   filesChanged / errors / nextAction，以及重启后
   「发现未完成任务 → 恢复环境检查 → **询问用户是否继续**」，
   并且明确写着「不得直接盲目恢复执行」。

   这条是整份文档里最容易被做错的一条 —— 因为一个「启动时自动接着跑」
   的实现看起来更聪明，实际上可能在你刚改过文件之后动手。
   所以这里的守卫里有一条是**扫描必须是纯读**。
   ══════════════════════════════════════════════════════════════ */

const recovery = require(join(ROOT, 'electron/core/task-recovery.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))
const taskPlan = require(join(ROOT, 'electron/core/task-plan.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('AG-012 · 任务持久化与重启恢复')

  const created = []

  /* ── nextActionOf：计划里第一条没打勾的 ── */
  check('取的是第一条没打勾的', taskPlan.nextActionOf(['[x] 一', '[ ] 二', '三']) === '二')
  check('全打勾了就为空', taskPlan.nextActionOf(['[x] 一', '[x] 二']) === '')
  check('没写勾选标记的也算「没做」', taskPlan.nextActionOf(['一']) === '一')
  check('不是数组时返回空（不炸）', taskPlan.nextActionOf(null) === '')
  check('剥掉标记再存', taskPlan.nextActionOf(['[ ] 改 main.ts']) === '改 main.ts')

  /* ── 新字段 ── */
  const t = taskCore.create({ goal: '恢复清单测试', sessionId: 'sess-rec', workdir: ROOT })
  created.push(t.id)
  check(
    '★ 新任务就有 nextAction / pausedAt / resumeCount（老任务读的时候当默认值）',
    typeof t.nextAction === 'string' && t.pausedAt === 0 && t.resumeCount === 0,
  )
  check('permissions 是数组', Array.isArray(t.permissions))

  taskCore.setPlan(t.id, ['[x] 第一步', '[ ] 第二步'])
  check('★ setPlan 顺手把 nextAction 存下来了', taskCore.get(t.id)?.nextAction === '第二步')

  /* ── pausedAt / resumeCount ── */
  taskCore.update(t.id, { status: 'paused', pausedAt: Date.now() })
  check('暂停会记下时刻', taskCore.get(t.id).pausedAt > 0)
  taskResume.reopen(t.id)
  check('★ 恢复一次，resumeCount = 1', taskCore.get(t.id).resumeCount === 1)
  taskCore.update(t.id, { status: 'paused' })
  taskResume.reopen(t.id)
  check('再恢复一次，resumeCount = 2', taskCore.get(t.id).resumeCount === 2)

  /* ── scan ── */
  taskCore.update(t.id, { status: 'paused' })
  const mine = recovery.scan().find((item) => item.id === t.id)
  check('扫得到未完成任务', Boolean(mine))
  check('带上 nextAction（重启后直接能告诉用户停在哪）', mine?.nextAction === '第二步')
  check('带上环境检查结果', Array.isArray(mine?.envChanged))
  check('带上计划进度', mine?.progress.done === 1 && mine?.progress.total === 2)
  check('带上能不能恢复', mine?.canResume === true)
  check('★ scan 是纯读 —— 不改任务状态', taskCore.get(t.id).status === 'paused')

  taskCore.update(t.id, { status: 'completed' })
  check('已完成的不在恢复清单里', !recovery.scan().some((item) => item.id === t.id))

  /* ── progressOf ── */
  const p = recovery.progressOf(['[x] a', '[x] b', '[ ] c'])
  check('progressOf 数得对', p.done === 2 && p.total === 3 && p.current === 2)
  check('全做完时 current = -1', recovery.progressOf(['[x] a']).current === -1)

  /* ── 源码守卫 ── */
  const recSrc = readCore('electron/core/task-recovery.cjs')
  check(
    '★ 恢复扫描不执行任何东西（只读 —— 文档要求「不得直接盲目恢复执行」）',
    !/\b(loop\.run|taskResume\.reopen|emit\()/.test(recSrc),
  )
  check('扫描用 unfinished 按项目工作目录筛选', /taskCore\.unfinished\(\{ workdir \}\)/.test(recSrc))
  check('扫描会做环境检查', recSrc.includes('taskResume.checkEnvironment'))

  const safetySrc = readCore('electron/handlers/safety.cjs')
  check('有 task:recovery 通道', safetySrc.includes("ipcMain.handle('task:recovery'"))

  check('preload 暴露了它', readCore('electron/preload.cjs').includes('taskRecovery:'))
  check(
    '前端 store 用的是 recovery（不是旧的 unfinished）',
    readCore('src/stores/useTaskStore.ts').includes('taskRecovery(workdir)'),
  )
  /*
   * AG-028：横幅撤掉了，这两件事现在在右栏任务中心的「详情」里。
   * 守的是**新家**，不是那个已经不存在的文件。
   */
  check(
    '★ 界面会告诉用户「离开后有文件被动过」',
    readCore('src/components/chat/TaskRow.tsx').includes('envChanged'),
  )
  check(
    '★ 界面会显示「下一步」',
    readCore('src/components/chat/taskCenterModel.ts').includes('nextAction'),
  )
  check(
    '★ 启动时会提示「上次有任务没做完」',
    readCore('src/hooks/useAppBootstrap.ts').includes('useTaskStore.getState().refresh()'),
  )
  check(
    '★ 启动提示也不自动跑（只 toast，不调 resumeTask）',
    !/resumeTask\(/.test(readCore('src/hooks/useAppBootstrap.ts')),
  )

  /* ── 收尾 ── */
  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
