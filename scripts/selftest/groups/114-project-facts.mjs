import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { disposeTasks, join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   项目事实层（`electron/core/project-facts.cjs`）—— 缺口 C

   缺的东西：长任务里对话被裁剪，**丢的是对话里的探索结果**（目录里有什么、
   测试怎么跑、关键文件在哪个子目录），于是模型反复侦察同一件事。
   做法是把它变成「从磁盘再算一次就有」的**派生视图**：每轮重扫、不写盘、
   不进 memory.json —— 裁掉也不会丢。

   这一组钉四件事：
     ① 扫出来的必须是**磁盘上真实有的**（不是猜的）；
     ② 失效机制：变了要显式说、目录没了宁可不给；
     ③ **不依赖对话历史** —— 这正是「裁剪后不用重新侦察」的机制本身；
     ④ 真注入路径通了（挂在 `taskContext.buildTaskState` 上，**两个分支都给**），
        而不是只有单元测试能调。挂 `taskState` 层是实测挑的：项目上下文那层会被
        `budget.project` 裁剪，长 AGENT.md 的项目里事实会被整段挤掉。
   ══════════════════════════════════════════════════════════════ */

const facts = require(join(ROOT, 'electron/core/project-facts.cjs'))
const project = require(join(ROOT, 'electron/core/project.cjs'))
const promptStack = require(join(ROOT, 'electron/core/prompt-stack.cjs'))
const taskContext = require(join(ROOT, 'electron/core/task-context.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

/** 造一个「像新项目」的目录：有 package.json（还没写 test 脚本）、src/、docs/ */
function makeProject({ withTest = false, withAgent = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'project-facts-'))
  const dir = join(base, '白板工具')
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const x = 1\n', 'utf8')
  writeFileSync(join(dir, 'docs', '说明.md'), '# 说明\n', 'utf8')
  const pkg = { name: 'board', version: '0.1.0', dependencies: { react: '^18.0.0' } }
  if (withTest) pkg.scripts = { test: 'node --test' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  writeFileSync(join(dir, 'tsconfig.json'), '{}\n', 'utf8')
  if (withAgent) writeFileSync(join(dir, 'AGENT.md'), '# 规矩\n先跑测试。\n', 'utf8')
  return { base, dir }
}

export async function run() {
  const { base, dir } = makeProject()
  const created = []
  try {
    group('项目事实层 / 扫出来的就是磁盘上的东西')
    facts.resetMemory()
    const text = facts.build({ workdir: dir })
    check('★ 说出这是哪个目录（不用再 ls）', text.includes('白板工具'), `实际=${text.slice(0, 120)}`)
    check('★ 说出顶层有什么（目录带 /）', text.includes('src/') && text.includes('docs/') && text.includes('package.json'))
    check('★ 说出测试入口「没有」（没写 scripts.test）', text.includes('测试入口：') && text.includes('**没有**'), `实际=${text.slice(0, 200)}`)
    check('认出了技术栈（React + TypeScript）', text.includes('React') && text.includes('TypeScript'), `实际=${text.slice(0, 200)}`)
    check('展开了关键子目录（src/ 下有什么）', /`src\/`：/.test(text) && text.includes('main.ts'), `实际=${text.slice(0, 240)}`)
    check('说明了「以本轮扫描为准」（免得和模型记忆冲突）', text.includes('以它为准'))
    check('在预算内（≤900 字符）', text.length <= facts.MAX_CHARS, `长度=${text.length}`)
    check('没有 workdir → 空串（不注入空标题）', facts.build({ workdir: '' }) === '' && facts.build() === '')
    check('目录不存在 → 空串（不给过期的事实）', facts.build({ workdir: join(base, '没有这个目录') }) === '')

    group('项目事实层 / 失效机制（变了要显式说）')
    facts.resetMemory()
    const first = facts.build({ workdir: dir })
    check('同一份磁盘、第二次扫 → 不再重复念叨「变了什么」', !facts.build({ workdir: dir }).includes('与上一轮相比变了'), `第一次=${first.slice(0, 80)}`)
    /* 真去改磁盘：加一个 tests/ 目录 + 给 package.json 补上 test 脚本 */
    mkdirSync(join(dir, 'tests'), { recursive: true })
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    pkg.scripts = { test: 'node --test' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
    const changed = facts.build({ workdir: dir })
    check('★ 顶层多了东西 → 显式标出来', changed.includes('与上一轮相比变了') && changed.includes('tests/'), `实际=${changed.slice(-160)}`)
    check('★ 测试入口从无到有 → 显式标出来（别按旧印象干活）', changed.includes('测试入口：（没有） → npm test'), `实际=${changed.slice(-200)}`)
    check('同一轮里已经是新值（顶层里有 tests/）', changed.includes('tests/'))
    /* 目录被删掉：必须宁可不给，也不给上一轮的旧事实 */
    facts.resetMemory()
    const before = facts.build({ workdir: dir })
    rmSync(dir, { recursive: true, force: true })
    const gone = facts.build({ workdir: dir })
    check('★ 目录没了 → 不给事实（而不是给上一轮的旧事实）', before.length > 0 && gone === '', `实际=${gone.slice(0, 120)}`)

    group('项目事实层 / 不依赖对话历史（裁剪也不会丢）')
    const again = makeProject({ withTest: true })
    try {
      facts.resetMemory()
      /* 两次之间不保留任何「对话」—— 事实仍应完整：这正是被裁剪后能恢复的机制 */
      const round1 = facts.build({ workdir: again.dir })
      facts.resetMemory()
      const round2 = facts.build({ workdir: again.dir })
      check('★ 清掉进程内记忆后重扫，事实一字不差（不靠历史）', round1 === round2, `差异片段=${round1.slice(0, 60)} vs ${round2.slice(0, 60)}`)
      check('★ 反复侦察的三件事都在：目录里有什么 / 测试怎么跑 / 关键子目录', round2.includes('src/') && round2.includes('npm test') && /`src\/`：/.test(round2))
      check('有测试入口时给的是跑法（不再要求先建）', round2.includes('npm test'))
      /* 这条是这次真正的机制：把事实挂到提示装配的真函数上，看它在不在 */
      const promptText = taskContext.buildTaskState({ sessionId: 'selftest-facts-fresh', userText: '继续改白板', workdir: again.dir })
      check('★ 经真正的提示装配函数（taskState 层）后事实还在', promptText.includes('这个项目的现状') && promptText.includes('npm test'), `实际=${promptText.slice(-200)}`)
      check('事实与「本轮请求」同时在场（没把旧行为顶掉）', promptText.includes('继续改白板'))
    } finally {
      rmSync(again.base, { recursive: true, force: true })
    }

    group('项目事实层 / git 摘要带 TTL（每轮不 spawn 一个进程）')
    const gitDir = mkdtempSync(join(tmpdir(), 'project-facts-git-'))
    try {
      facts.resetMemory()
      const one = facts.scan(gitDir)
      const two = facts.scan(gitDir)
      check('同一个目录两次扫 → git 那段走缓存（时间戳不变）', one.git.at === two.git.at, `at=${one.git.at} / ${two.git.at}`)
      check('非 git 目录也不抛（只是没有 Git 那行）', facts.build({ workdir: gitDir }).includes('Git：') === false)
      check('TTL 是明确的 30 秒（写死在常量里，不是随口说）', facts.GIT_TTL_MS === 30 * 1000, `实际=${facts.GIT_TTL_MS}`)
    } finally {
      rmSync(gitDir, { recursive: true, force: true })
    }

    group('项目事实层 / 真注入路径（挂在 taskState 层，每轮都给）')
    const withAgent = makeProject({ withAgent: true })
    try {
      facts.resetMemory()
      const fresh = taskContext.buildTaskState({ sessionId: 'selftest-facts-path', userText: '给白板加一个导出', workdir: withAgent.dir })
      check('★ 新活第一轮：项目上下文里既有 AGENT.md 的规矩、也有项目现状', project.buildPromptSection({ workdir: withAgent.dir }).includes('先跑测试') && fresh.includes('这个项目的现状'))
      check('事实排在台账 / 请求之后（先说要干什么，再说现场什么样）', fresh.indexOf('给白板加一个导出') < fresh.indexOf('这个项目的现状'))
      /* ★ 关键：有台账时（不是第一轮）也必须给 —— 只给第一轮等于没治裁剪 */
      const me = taskCore.create({ goal: '把导出功能写完', sessionId: 'selftest-facts-busy' })
      created.push(me.id)
      facts.resetMemory()
      const busy = taskContext.buildTaskState({ sessionId: 'selftest-facts-busy', userText: '继续', workdir: withAgent.dir })
      check('★ 已有未完成任务时事实照样注入（这是治裁剪的关键）', busy.includes('这个项目的现状'), `实际=${busy.slice(-200)}`)
      check('同一段里台账本身还在', busy.includes('把导出功能写完'))
      const empty = taskContext.buildTaskState({ sessionId: 'selftest-facts-none', userText: '随便', workdir: join(withAgent.base, '不存在') })
      check('目录不存在时不注入事实（也不摆一个空标题）', !empty.includes('这个项目的现状'))
    } finally {
      rmSync(withAgent.base, { recursive: true, force: true })
    }

    /*
     * ★ 这一组就是缺口 C 的验收场景：**长任务 + 对话被裁剪**。
     *   裁剪之后历史消息没了 —— 但事实是每轮从磁盘重算的，所以还在系统提示里。
     *   这里用真的分层装配（prompt-stack）跑一遍，不是只看那个函数返回值。
     */
    group('项目事实层 / 裁剪场景：历史掉光，事实还在')
    const trimCase = makeProject({ withTest: true })
    try {
      facts.resetMemory()
      const state = taskContext.buildTaskState({ sessionId: 'selftest-facts-trim', userText: '接着把渲染那块写完', workdir: trimCase.dir })
      const built = promptStack.build({ assistantName: 'Agent', taskState: state, currentTime: '' })
      const promptText = built.message.content
      check('★ 历史一条都不给（模拟裁光），事实照样在系统提示里', promptText.includes('这个项目的现状'), `实际=${promptText.slice(-240)}`)
      check('★ 「不用重新侦察」的三件事都进了提示', promptText.includes('npm test') && promptText.includes('src/') && promptText.includes('顶层（'))
      check('事实落在 Task State 层里（没被塞进需要按预算裁剪的那层）', built.layers.find((l) => l.id === 'taskState')?.content.includes('这个项目的现状') === true)
      /*
       * 空层仍然在 `layers` 里，只是 `content` 为空（由 toSystemMessage 过滤）——
       * 所以判据看 content，不看 find() 有没有结果。第一版就是这里写错、被自己抓出来的。
       */
      check('projectInstructions 层是空的（那层会被 budget.project 裁，事实不该在那儿）', (built.layers.find((l) => l.id === 'projectInstructions')?.content ?? '') === '', `实际=${built.layers.find((l) => l.id === 'projectInstructions')?.content}`)
    } finally {
      rmSync(trimCase.base, { recursive: true, force: true })
    }
  } finally {
    const left = disposeTasks(created)
    check('测完把建出来的测试任务删干净（别在 data/tasks 里堆东西）', left.length === 0, `没删掉的：${left.join(' ')}`)
    rmSync(base, { recursive: true, force: true })
  }
}
