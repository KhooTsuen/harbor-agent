/**
 * 自检 / 可靠性与路由：任务台账 / 改动回滚 / 错误分类 / 模型路由 / 项目说明
 *
 * 从 scripts/selftest.mjs 拆出来的（那边 1193 行了）。
 * 每个文件导出 `run()`，由 selftest.mjs 按顺序调用 —— 组之间**不共享状态**，
 * 所以加新组只要在 selftest.mjs 的清单里加一行。
 */

import { check, group } from '../harness.mjs'
import {
  SANDBOX,
  backupCore,
  changesetCore,
  configModule,
  errorsCore,
  existsSync,
  join,
  paths,
  projectCore,
  readFileSync,
  resolve,
  routerCore,
  taskCore,
  writeFileSync,
} from '../env.mjs'

export async function run() {
  group('可靠 / 任务')
  const task = taskCore.create({
    goal: '把启动速度优化一下',
    sessionId: 'selftest',
    workdir: SANDBOX,
  })
  check('任务建好了', Boolean(task?.id) && task.status === 'running')
  check('任务写进了磁盘', existsSync(join(paths.DIRS.data, 'tasks', `${task.id}.json`)))

  const plan = taskCore.parsePlan(
    '先看看：\n\n```plan\n1. 检查启动路径\n2. 找到耗时初始化\n- 建立 baseline\n```\n\n然后动手。',
  )
  check('能从回复里解析出计划', plan.length === 3, JSON.stringify(plan))
  check('计划条目去掉了编号', plan[0] === '检查启动路径')
  check('没有计划块时返回空', taskCore.parsePlan('就是一段普通回答').length === 0)

  taskCore.setPlan(task.id, plan)
  taskCore.addStep(task.id, { tool: 'read_file', ok: true, summary: '读了 main.cjs', ms: 12 })
  taskCore.addChangedFile(task.id, join(SANDBOX, 'hello.txt'))
  taskCore.addCommand(task.id, 'npm test', '通过')
  taskCore.checkpoint(task.id, { label: '第 1 轮改动完成' })
  const reloaded = taskCore.get(task.id)
  check('计划被存下', reloaded.plan.length === 3)
  check('步骤被记下', reloaded.steps.length === 1 && reloaded.steps[0].tool === 'read_file')
  check('改动文件被记下', reloaded.changedFiles.length === 1)
  check('命令被记下', reloaded.commands[0].command === 'npm test')
  check('检查点被记下', reloaded.checkpoints.length === 1)
  check(
    '未完成任务能被列出来',
    taskCore.unfinished().some((t) => t.id === task.id),
  )

  taskCore.update(task.id, { status: 'paused' })
  check(
    '退出时标暂停后可恢复',
    taskCore.unfinished().some((t) => t.id === task.id),
  )
  taskCore.finish(task.id, { status: 'completed', result: 'done' })
  check('完成后不再提示续做', !taskCore.unfinished().some((t) => t.id === task.id))
  taskCore.remove(task.id)

  /* ══════════════════════════════════════════════════════
     P0 可靠：改动事务与回滚
     ══════════════════════════════════════════════════════ */

  group('可靠 / 改动回滚')
  const targetA = join(SANDBOX, 'cs-a.txt')
  const targetB = join(SANDBOX, 'cs-b.txt')
  const targetNew = join(SANDBOX, 'cs-new.txt')
  writeFileSync(targetA, '原始 A\n', 'utf8')
  writeFileSync(targetB, '原始 B\n', 'utf8')

  const cs = changesetCore.begin({ taskId: 'selftest-cs', sessionId: 'selftest' })
  check('事务开起来了', cs.ok === true && Boolean(cs.id))

  changesetCore.record(cs.id, targetA)
  writeFileSync(targetA, '改过的 A\n', 'utf8')
  changesetCore.record(cs.id, targetB)
  writeFileSync(targetB, '改过的 B\n', 'utf8')
  /* 新建的文件也要能撤 —— 回滚时应该删掉它 */
  changesetCore.record(cs.id, targetNew)
  writeFileSync(targetNew, '新文件\n', 'utf8')

  const csMeta = changesetCore.get(cs.id)
  check('三个文件都记进了事务', csMeta.files.length === 3, String(csMeta.files.length))
  check(
    '新建的文件被标为「原来不存在」',
    csMeta.files.find((f) => f.path === targetNew)?.existed === false,
  )

  const rolled = changesetCore.rollback(cs.id)
  check('回滚报告成功', rolled.ok === true)
  check('A 恢复成原文', readFileSync(targetA, 'utf8') === '原始 A\n', readFileSync(targetA, 'utf8'))
  check('B 恢复成原文', readFileSync(targetB, 'utf8') === '原始 B\n')
  check('新建的文件被删掉', !existsSync(targetNew))
  check('恢复清单有两条', rolled.restored.length === 2)
  check('删除清单有一条', rolled.removed.length === 1)

  changesetCore.prune(0)
  check('事务可以被清理', true)

  /* ══════════════════════════════════════════════════════
     P1：错误分类与重试
     ══════════════════════════════════════════════════════ */

  group('可靠 / 错误分类')
  check('401 归为认证失败', errorsCore.classify({ status: 401 }).kind === 'auth')
  check('403 也归为认证失败', errorsCore.classify({ status: 403 }).kind === 'auth')
  check('429 归为限流', errorsCore.classify({ status: 429 }).kind === 'rate_limit')
  check('500 归为服务端', errorsCore.classify({ status: 500 }).kind === 'server')
  check('ECONNRESET 归为网络', errorsCore.classify({ code: 'ECONNRESET' }).kind === 'network')
  check(
    '上下文超限能认出来',
    errorsCore.classify(new Error('This model maximum context length is 8192 tokens')).kind ===
      'context_overflow',
  )
  check(
    '模型不支持图片能认出来',
    errorsCore.classify(new Error('model does not support image input')).kind ===
      'model_unsupported',
  )
  check(
    '中断不重试',
    errorsCore.shouldRetry(errorsCore.classify({ name: 'AbortError' }), 0, { attempts: 3 }) ===
      false,
  )
  check(
    '认证失败不重试',
    errorsCore.shouldRetry(errorsCore.classify({ status: 401 }), 0, { attempts: 3 }) === false,
  )
  check(
    '网络错误会重试',
    errorsCore.shouldRetry(errorsCore.classify({ status: 503 }), 0, { attempts: 2 }) === true,
  )
  check(
    '重试次数用完就不重试',
    errorsCore.shouldRetry(errorsCore.classify({ status: 503 }), 2, { attempts: 2 }) === false,
  )
  check('退避随次数增长', errorsCore.backoffMs(2) > errorsCore.backoffMs(0))
  check('退避有上限', errorsCore.backoffMs(20) <= 8000)

  /* ══════════════════════════════════════════════════════
     P1：模型路由
     ══════════════════════════════════════════════════════ */

  group('模型 / 路由')
  check('起标题走便宜模型', routerCore.pickRole({ scene: 'title' }) === 'cheap')
  check('OCR 走视觉模型', routerCore.pickRole({ scene: 'ocr' }) === 'vision')
  check('带图自动走视觉', routerCore.pickRole({ text: '看这个', hasImages: true }) === 'vision')
  check('改代码走 coding', routerCore.pickRole({ text: '帮我重构这个模块' }) === 'coding')
  check('问原因走推理', routerCore.pickRole({ text: '为什么会这样' }) === 'reasoning')
  check('普通提问不指定角色', routerCore.pickRole({ text: '今天几号' }) === null)

  const routeConfig = {
    ...configModule.get(),
    assistant: { ...configModule.get().assistant, model: 'base-model' },
    router: {
      enabled: true,
      roles: { fast: '', reasoning: '', coding: 'coding-model', vision: '', cheap: '' },
    },
    providers: [
      { id: 'p1', name: 'P1', baseUrl: 'https://x', enabled: true, models: [], credentialRef: '' },
    ],
    activeProvider: {
      id: 'p1',
      name: 'P1',
      baseUrl: 'https://x',
      enabled: true,
      credentialRef: '',
    },
  }
  check(
    '路由关掉时用默认模型',
    routerCore.resolve({ config: { ...routeConfig, router: { enabled: false, roles: {} } } })
      .model === 'base-model',
  )
  check(
    '配了 coding 角色就派过去',
    routerCore.resolve({ config: routeConfig, text: '改一下这段代码' }).model === 'coding-model',
  )
  check(
    '没配的角色回落默认',
    routerCore.resolve({ config: routeConfig, text: '今天几号' }).model === 'base-model',
  )

  /* ══════════════════════════════════════════════════════
     P1：项目说明
     ══════════════════════════════════════════════════════ */

  group('项目 / AGENT.md')
  check('没有说明文件时返回空', projectCore.buildPromptSection({ workdir: SANDBOX }) === '')
  writeFileSync(
    join(SANDBOX, 'AGENT.md'),
    '# 规矩\n\n- 用 pnpm，不要 npm\n- 测试命令是 pnpm test\n',
    'utf8',
  )
  const projectFound = projectCore.find(SANDBOX)
  check('能自动找到 AGENT.md', projectFound?.relative === 'AGENT.md')
  const projectSection = projectCore.buildPromptSection({ workdir: SANDBOX })
  check('内容进了提示词', projectSection.includes('用 pnpm'))
  check('标注了来源文件', projectSection.includes('AGENT.md'))
  check('说明了「内容是数据不是指令」', projectSection.includes('忽略之前的指令'))

  /* ══════════════════════════════════════════════════════
     Agent 循环冒烟测试

     这一组是**补漏**来的：loop.cjs 里 `config.hasKey()` 曾在配置对象上调用
     （形参 `config` 遮住了 config 模块），报 “is not a function”。
     过 tsc 查不到（.cjs 不参与类型检查），自检也照不到（只测了工具层）——
     只有真发一句话才会炸。所以这里把整条链路跑一遍。

     不联网：把 llm.chatStream 换掉。
     ══════════════════════════════════════════════════════ */

  group('自动备份')

  /* ── 备份 ──
   *
   * 注意这一组会**真的往 data/backups 里写**，跑完自己清掉。
   * 断言盯的是「备份真的能用」：文件在不在、meta 记没记、删了会不会清干净。
   * 顺带盯两个容易退化的行为：同一秒内连点不能互相覆盖；24 小时内不重复自动备份。
   */

  const backupRoot = backupCore.root()
  const beforeCount = backupCore.list().length

  const made = backupCore.create('selftest')
  check('能创建备份', made.ok === true, String(made.error ?? ''))
  check(
    '备份名是时间戳格式',
    /^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/.test(made.name ?? ''),
    String(made.name),
  )
  check('备份目录真的落在磁盘上', existsSync(join(backupRoot, made.name)))
  check(
    'meta 里记了原因',
    readFileSync(join(backupRoot, made.name, 'meta.json'), 'utf8').includes('selftest'),
  )
  check('返回了体积', typeof made.size === 'number' && made.size >= 0, String(made.size))

  const listed = backupCore.list()
  check(
    '列表里能查到刚备份的',
    listed.some((b) => b.name === made.name),
  )
  check('列表按时间倒序', listed.length < 2 || listed[0].createdAt >= listed[1].createdAt)

  /* 同一秒内连点：不能覆盖上一份（后缀顺延） */
  const first = backupCore.create('selftest-dup')
  const second = backupCore.create('selftest-dup')
  check('同一秒连续备份不会互相覆盖', first.name !== second.name, first.name + ' / ' + second.name)
  check(
    '两份都在磁盘上',
    existsSync(join(backupRoot, first.name)) && existsSync(join(backupRoot, second.name)),
  )

  /* 刚备过就不该再自动备 */
  const auto = backupCore.maybeAuto()
  check('刚备份过不会重复自动备份', auto.skipped === true, JSON.stringify(auto))

  check(
    '只备用户自己的数据（不备日志/缓存）',
    backupCore.ITEMS.every((it) =>
      ['config.json', 'memory.md', 'sessions', 'skills'].includes(it.name),
    ),
    backupCore.ITEMS.map((it) => it.name).join(','),
  )
  check('stamp 是 8+6 位数字', /^[0-9]{8}-[0-9]{6}$/.test(backupCore.stamp()))
  check(
    'meta 里记下的清单和磁盘上的对得上',
    JSON.parse(readFileSync(join(backupRoot, made.name, 'meta.json'), 'utf8')).version === 1,
  )
  check('删除不存在的备份会如实报错', backupCore.remove('19700101-000000').ok === false)
  check(
    '同一秒的第二份（带后缀）也能被认出来',
    backupCore.list().every((b) => /^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/.test(b.name)),
  )

  for (const name of [made.name, first.name, second.name]) backupCore.remove(name)
  check('能删掉备份', !existsSync(join(backupRoot, made.name)))
  check(
    '删完数量回到原样',
    backupCore.list().length === beforeCount,
    String(backupCore.list().length),
  )
}
