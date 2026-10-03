import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { disposeTasks, join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   「先建最小验证」这件事的注入口径（`electron/core/verify-hint.cjs`）

   缺的东西：用 Harbor 做**新项目**时，「先建最小验证」是「想到了才做」；
   而改 Harbor 自己时 verify 链是现成的，缺的只是「去跑」。所以两种口径，
   判据是**磁盘上有没有测试入口**，不靠模型记得。

   这一组钉的就是「提醒不许变成噪音或说教」的三条边界：
     ① 没入口 → 要求先建（并说清形态）；
     ② 有入口 → 给命令，**不许**再要求新建；
     ③ 已经有台账时（不是新活第一轮）→ **不注入**。
   ══════════════════════════════════════════════════════════════ */

const verifyHint = require(join(ROOT, 'electron/core/verify-hint.cjs'))
const taskContext = require(join(ROOT, 'electron/core/task-context.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

/** 造两个真目录来测：一个没有任何测试入口，一个有现成的 `npm test` */
function makeDirs() {
  const base = mkdtempSync(join(tmpdir(), 'verify-hint-'))
  const bare = join(base, '光秃秃的项目')
  const withTest = join(base, '有测试的项目')
  mkdirSync(bare, { recursive: true })
  mkdirSync(withTest, { recursive: true })
  writeFileSync(join(withTest, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }), 'utf8')
  return { base, bare, withTest }
}

export async function run() {
  const dirs = makeDirs()
  const created = []
  try {
    group('先建最小验证 / 识别测试入口（复用 workspace-summary，不另写一份）')
    check('没有测试入口的目录 → 认成「没有」', verifyHint.testEntry(dirs.bare).command === '', `实际=${verifyHint.testEntry(dirs.bare).command}`)
    check('有 scripts.test 的目录 → 认出 npm test', verifyHint.testEntry(dirs.withTest).command === 'npm test', `实际=${verifyHint.testEntry(dirs.withTest).command}`)
    check('空 workdir → 不给口径', verifyHint.testEntry('').command === '' && verifyHint.testEntry('').name === '')
    check(
      '目录不存在 → 既不给命令也不给名字（不冲着不存在的目录喊话）',
      verifyHint.testEntry(join(dirs.base, '根本没有这个目录')).name === '',
    )

    group('先建最小验证 / 两种口径')
    const bareText = verifyHint.build({ workdir: dirs.bare })
    check('★ 没有入口 → 要求「先建最小验证」', bareText.includes('先建最小验证'), `实际=${bareText.slice(0, 80)}`)
    check('说清了形态（一条命令能跑起来的最小验证）', /一条命令/.test(bareText) && /最小验证/.test(bareText))
    check('点名了具体目录（不是泛泛的通用规矩）', bareText.includes('光秃秃的项目'), `实际=${bareText.slice(0, 120)}`)

    const withTestText = verifyHint.build({ workdir: dirs.withTest })
    check('★ 有入口 → 给出那条命令', withTestText.includes('npm test'), `实际=${withTestText.slice(0, 120)}`)
    check('★ 有入口时**不许**再要求新建（那就是误报）', !withTestText.includes('先建最小验证'), `实际=${withTestText.slice(0, 160)}`)
    check('有入口时要求先拿基线（改前 vs 改后）', withTestText.includes('基线'))
    check('两种口径都在预算内（≤400 字符）', bareText.length <= verifyHint.MAX_CHARS && withTestText.length <= verifyHint.MAX_CHARS, `长度=${bareText.length} / ${withTestText.length}`)
    check('没有 workdir → 空串（不注入一个空标题）', verifyHint.build({ workdir: '' }) === '' && verifyHint.build() === '')

    group('先建最小验证 / 真跑注入路径（taskState 层）')
    const freshBare = taskContext.buildTaskState({
      sessionId: 'selftest-verify-hint-fresh-bare',
      userText: '给这个项目加一个登录页',
      workdir: dirs.bare,
    })
    check('★ 新活第一轮（无测试入口）→ 注入里带「先建最小验证」', freshBare.includes('先建最小验证'), `实际=${freshBare.slice(0, 120)}`)
    check('同一段里仍然带着「本轮请求」（没把旧行为顶掉）', freshBare.includes('给这个项目加一个登录页'))

    const freshWithTest = taskContext.buildTaskState({
      sessionId: 'selftest-verify-hint-fresh-test',
      userText: '给这个项目加一个登录页',
      workdir: dirs.withTest,
    })
    check('★ 新活第一轮（有测试入口）→ 注入的是命令，不是「先建」', freshWithTest.includes('npm test') && !freshWithTest.includes('先建最小验证'))

    /* 老调用方不传 workdir：必须照旧能用（不能因为多加一个参数就炸） */
    const noWorkdir = taskContext.buildTaskState({ sessionId: 'selftest-verify-hint-fresh-none', userText: '随便一件事' })
    check('不传 workdir 时不炸、也不注入口径（向后兼容）', noWorkdir.includes('随便一件事') && !noWorkdir.includes('先建最小验证'))

    /* ③ 已经有台账（不是新活第一轮）→ 不许再喊 */
    const busy = taskCore.create({ goal: '把说明文档改一遍', sessionId: 'selftest-verify-hint-busy' })
    created.push(busy.id)
    const withLedger = taskContext.buildTaskState({
      sessionId: 'selftest-verify-hint-busy',
      userText: '继续',
      workdir: dirs.bare,
    })
    check('★ 已有未完成任务时**不注入**验证口径（每轮都喊就是噪音）', !withLedger.includes('先建最小验证'), `实际=${withLedger.slice(0, 120)}`)
    check('有台账时仍然注入台账本身（没把原功能弄丢）', withLedger.includes('把说明文档改一遍'), `实际=${withLedger.slice(0, 120)}`)
  } finally {
    const left = disposeTasks(created)
    check('测完把建出来的测试任务删干净（别在 data/tasks 里堆东西）', left.length === 0, `没删掉的：${left.join(' ')}`)
    rmSync(dirs.base, { recursive: true, force: true })
  }
}
