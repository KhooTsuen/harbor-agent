import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   双模型协作与读图授权

   本组只钉**判据层**（不联网、不启子进程）：
     · 默认关、只认严格 true（装了就变双模型是不可接受的）
     · A/B 必须指定准确的供应商和模型
     · 计划/验收的 json 解析「解析不出就 null」，绝不从自然语言猜
     · 执行痕迹只认 `ok:true` 的写入与真实六态，不采信模型自述
     · 工具参数不能自带权限根或更换供应商

   真闭环（真 CLI + 真 HTTP）由 `tmp/` 下的端到端脚本做，进不了自检。
   ══════════════════════════════════════════════════════════════ */

const collabConfig = require(join(ROOT, 'electron/core/collab-config.cjs'))
const collabCodex = require(join(ROOT, 'electron/core/collab-codex.cjs'))
const collabPlanner = require(join(ROOT, 'electron/core/collab-planner.cjs'))
const collabTask = require(join(ROOT, 'electron/core/collab-task.cjs'))
const collabTrace = require(join(ROOT, 'electron/core/collab-trace.cjs'))
const collabImages = require(join(ROOT, 'electron/core/collab-images.cjs'))
const imageReader = require(join(ROOT, 'electron/core/tools/read_image.cjs'))
const fixTool = require(join(ROOT, 'electron/core/tools/apply_test_fix.cjs'))
const mcpFix = require(join(ROOT, 'electron/core/codex-mcp-fix-tool.cjs'))

export async function run() {
  group('图片交接 · 真实图像负载与文字辅助清晰区分')
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const directConfig = { providers: [{ id: 'visual-a', kind: 'openai', enabled: true, models: ['same-name'], modelCapabilities: { 'same-name': { vision: true } } }] }
  const direct = await collabImages.prepare([png], { kind: 'openai', providerId: 'visual-a', model: 'same-name' }, directConfig)
  check('有视觉能力的指定供应商收到原始图像 URL', direct.images[0] === png && direct.analysis === '')
  const originalRead = imageReader.fromDataUrl
  try {
    imageReader.fromDataUrl = async () => '视觉模型识别结果：红色方块'
    const assisted = await collabImages.prepare([png], { kind: 'codex-cli', providerId: 'cli' }, {
      providers: [{ id: 'visual-a', kind: 'openai', enabled: true, models: ['same-name'], modelCapabilities: { 'same-name': { vision: true } } }],
    }, { visionProvider: { id: 'visual-a', kind: 'openai', models: ['same-name'], modelCapabilities: { 'same-name': { vision: true } } }, visionModel: 'same-name' })
    check('无视觉能力后端只收到文字分析，不假称收到图片', assisted.images.length === 0 && assisted.analysis.includes('红色方块'))
    check('多模态请求构造保留 image_url 数据块', collabImages.contentWithImages('请看图', [png])[1]?.image_url?.url === png)
  } finally {
    imageReader.fromDataUrl = originalRead
  }
  await checkLocalImage(png)
  /* ── ① 默认关 ─────────────────────────────────────────── */
  group('协作 · 默认单助手，用户主动选双模型后开启')
  check('★★★ 默认值 enabled=false', collabConfig.COLLAB_DEFAULTS.enabled === false)
  check('★★★ 只认严格 true', collabConfig.normalize({ enabled: 'true' }).enabled === false)
  check('★★ 非对象输入使用默认值', collabConfig.normalize(null).enabled === false)
  check('★ 真 true 才留', collabConfig.normalize({ enabled: true }).enabled === true)

  /* ── ② 角色能力化（A/B 各能由哪些后端承担，不是写死单一 kind） ── */
  group('协作 · 角色能力化（A/B 各声明能胜任的 kind，不再写死）')
  check('★★★ A 方能 codex-cli', collabConfig.ROLES.planner.kinds.includes('codex-cli'))
  check('★★★ B 方能 openai（DeepSeek 走这条）', collabConfig.ROLES.executor.kinds.includes('openai'))
  check('★★★ A 方也能 openai（openai 做规划/验收）', collabConfig.ROLES.planner.kinds.includes('openai'))
  check('★★★ B 方也能 codex-cli（经 MCP 桥执行）', collabConfig.ROLES.executor.kinds.includes('codex-cli'))
  check('★★★ canRole 判据生效', collabConfig.canRole('planner', 'openai') === true)
  check('★★★ 不认识的 kind 不能胜任', collabConfig.canRole('executor', 'x') === false)
  check(
    '★★ 两个角色 id 不同且都带职责说明',
    collabConfig.ROLES.planner.id !== collabConfig.ROLES.executor.id &&
      Boolean(collabConfig.ROLES.planner.duty),
  )

  /* ── ③ json 解析：解析不出就 null ─────────────────────── */
  group('协作 · 结构化输出「解析不出就不猜」')
  check(
    '★★★ 围栏 json 能解析',
    collabCodex.parseJsonBlock('前言\n```json\n{"verdict":"PASS"}\n```')?.verdict === 'PASS',
  )
  check(
    '★★ 裸对象也能解析',
    collabCodex.parseJsonBlock('说明 {"verdict":"BLOCKED"} 结尾')?.verdict === 'BLOCKED',
  )
  check(
    '★★★ 没有 json → null（不替模型下结论）',
    collabCodex.parseJsonBlock('我觉得可以了') === null,
  )
  check('★★ 坏 json → null', collabCodex.parseJsonBlock('{"verdict":}') === null)
  check('★★ 顶层数组不算（形状不对）', collabCodex.parseJsonBlock('[1,2,3]') === null)
  check(
    '★★★ 验收结论只认三个值',
    collabCodex.VERDICTS.size === 3 && !collabCodex.VERDICTS.has('OK'),
  )

  /* ── ④ 痕迹只认真实 ───────────────────────────────────── */
  group('协作 · 执行痕迹只认内核记录的真实状态')
  const runs = [
    { name: 'read_file', args: {}, ok: true, output: '' },
    { name: 'edit_file', args: { path: 'a.js' }, ok: false, output: '用户拒绝了这个操作' },
    {
      name: 'apply_test_fix',
      args: { proposals: [{ path: 'b.js' }] },
      ok: true,
      output: '执行记录 ptr_ok1',
    },
    { name: 'run_project_test', args: { id: 't' }, ok: false, output: '测试未通过\n[退出码 1]' },
  ]
  const t = collabTrace.extractTrace(runs)
  check(
    '★★★ 只有 ok:true 的写入才算"改过"（被拒的那次不算）',
    t.writes.length === 1 && t.writes[0] === 'b.js',
    JSON.stringify(t.writes),
  )
  check(
    '★★★ 测试状态来自 classifyRun（不是模型说的）',
    t.lastTest?.status === 'FAIL',
    t.lastTest?.status,
  )
  check('★★ 执行记录 id 从正文里读到', t.executionId === 'ptr_ok1')
  check('★★ 没有 toolRuns → 空痕迹（不编）', collabTrace.extractTrace([]).lastTest === null)
  check('★ 空输入不抛', collabTrace.extractTrace(undefined).writes.length === 0)
  const strictRoles = collabTask.resolveRoles({}, {})
  check('双模型未选择 A/B 时保持未选择，不静默回退', strictRoles.planner.kind === '' && strictRoles.executor.kind === '')
  let rejectedSelection = false
  try { collabTask.providerForRole({ providers: [] }, strictRoles.planner) } catch { rejectedSelection = true }
  check('缺失模型选择 fail-closed', rejectedSelection)

  /* ── ⑤ 汇报必须能分清 A/B ─────────────────────────────── */
  group('协作 · 汇报分得清「谁做了什么」')
  const report = collabTrace.renderReport({
    plan: { problem: 'p', scope: ['a.js'], expected: 'e', verify: 'v' },
    review: { verdict: 'NEEDS_CHANGES', reasons: ['r'], issues: ['i'] },
    trace: {
      writes: ['a.js'],
      lastTest: { status: 'FAIL', exitCode: 1, testId: 't' },
      executionId: 'x',
      tools: [],
    },
    phases: ['plan', 'execute', 'review'],
  })
  check('★★★ 汇报含 A 规划段', /A · Codex CLI（检查/.test(report))
  check('★★★ 汇报含 B 执行段', /B · DeepSeek（执行）/.test(report))
  check('★★★ 汇报含 A 验收段', /A · Codex CLI（验收）/.test(report))
  check(
    '★★ 验收意见原样带出（不改写）',
    /NEEDS_CHANGES/.test(report) && /需要修的问题/.test(report),
  )

  /* ── ⑥ 协作不能自带权限 ───────────────────────────────── */
  group('协作 · 参数面没有权限入口')
  const fixProps = Object.keys(fixTool.parameters?.properties ?? {})
  check(
    '★★★ 修复工具没有 provider / model 参数',
    !fixProps.includes('provider') && !fixProps.includes('model'),
  )
  check('★★★ 修复工具没有 root 参数（根只能来自授权配置）', !fixProps.includes('root'))
  const mcpNames = (mcpFix.TOOLS ?? []).map((x) => String(x?.name ?? ''))
  check(
    '★★ MCP 侧也没有"指定另一个模型"的入口',
    !mcpNames.some((n) => /model|provider|role/i.test(n)),
    mcpNames.join(','),
  )
  await checkFlow()
}

async function checkLocalImage(png) {
  group('授权目录读图 · 真实字节进入视觉请求')
  const fs = require('node:fs')
  const path = require('node:path')
  const { DIRS } = require(join(ROOT, 'electron/core/paths.cjs'))
  const config = require(join(ROOT, 'electron/core/config.cjs'))
  const llm = require(join(ROOT, 'electron/core/llm.cjs'))
  const own = fs.mkdtempSync(path.join(DIRS.data, 'image-own-'))
  const outside = fs.mkdtempSync(path.join(DIRS.data, 'image-outside-'))
  const file = path.join(own, 'real.png')
  const foreign = path.join(outside, 'real.png')
  const bytes = Buffer.from(png.split(',')[1], 'base64')
  fs.writeFileSync(file, bytes)
  fs.writeFileSync(foreign, bytes)
  const original = { hasKey: config.hasKey, chatStream: llm.chatStream }
  const provider = { id: 'image-test', kind: 'openai', enabled: true,
    baseUrl: 'https://example.invalid/v1', models: ['vision-test'],
    modelCapabilities: { 'vision-test': { vision: true } } }
  const ctx = { workdir: own, sessionId: 'image-session', allowNetwork: true,
    vision: { config: { providers: [provider] }, provider, model: 'vision-test' } }
  let sentImage = ''
  try {
    config.hasKey = () => true
    llm.chatStream = async ({ messages }) => {
      sentImage = messages[0].content[1].image_url.url
      return { content: '一张图片' }
    }
    const result = await imageReader.run({ path: 'real.png' }, ctx)
    check('授权目录内实际读取图片字节并送进视觉请求', sentImage === png && result.includes('一张图片'))
    let denied = false
    try { await imageReader.run({ path: foreign }, ctx) } catch (error) {
      denied = error?.code === 'PERMISSION_REQUIRED'
    }
    check('越出当前对话目录时先要求授权，不能读取图片字节', denied)
  } finally {
    config.hasKey = original.hasKey
    llm.chatStream = original.chatStream
    for (const dir of [own, outside]) {
      const target = path.resolve(dir)
      if (target.startsWith(path.resolve(DIRS.data) + path.sep) && path.basename(target).startsWith('image-'))
        fs.rmSync(target, { recursive: true })
    }
  }
}

async function checkFlow() {
  group('协作 · 编排与聊天结果契约（上游替身，真实编排）')
  const fs = require('node:fs')
  const config = require(join(ROOT, 'electron/core/config.cjs'))
  const paths = require(join(ROOT, 'electron/core/paths.cjs'))
  const loop = require(join(ROOT, 'electron/core/loop.cjs'))
  const collab = require(join(ROOT, 'electron/core/collab.cjs'))
  const chat = require(join(ROOT, 'electron/handlers/chat-run.cjs'))
  const original = { get: config.get, plan: collabCodex.planProjects, review: collabCodex.reviewResult,
    openPlan: collabPlanner.planProjects, openReview: collabPlanner.reviewResult, run: loop.run }
  const root = join(paths.DIRS.data, 'collab-flow')
  fs.mkdirSync(root, { recursive: true })
  const target = join(root, 'fixture.js')
  fs.writeFileSync(target, 'unchanged')
  const cfg = { ...config.get(), providers: [...config.get().providers, { id: 'collab-test', kind: 'openai', enabled: true,
    models: ['selected-planner', 'selected-worker'], baseUrl: 'https://example.invalid/v1', modelCapabilities: {} }],
    assistant: { model: 'global-model' }, collab: { enabled: true },
    projectTests: { enabled: false, items: [] } }
  const plan = { problem: 'p', scope: ['fixture.js'], expected: 'e', verify: 'v' }
  let executions = 0
  let reviews = 0
  let selectedModel = ''
  let plannerRoute = ''
  let reviewRoute = ''
  let failPlan = false
  const input = { goal: 'g', selected: true, projectRoot: root, config: cfg, sessionId: 'collab-session', threadSettings: { allowTools: false }, confirm: async () => true,
    planner: { kind: 'openai', model: 'selected-planner', providerId: 'collab-test' },
    executor: { kind: 'openai', model: 'selected-worker', providerId: 'collab-test' } }
  try {
    config.get = () => cfg
    collabPlanner.planProjects = async ({ model, providerId }) => {
      plannerRoute = `${providerId}/${model}`
      return failPlan
      ? { ok: false, code: 'PLANNER_EMPTY', message: '没有规划输出' }
      : { ok: true, plan }
    }
    collabPlanner.reviewResult = async ({ model, providerId }) => {
      reviewRoute = `${providerId}/${model}`
      reviews++
      return { ok: true, review: { verdict: 'PASS', reasons: [], issues: [] } }
    }
    loop.run = async ({ config: effective }) => {
      executions++
      selectedModel = `${effective._collabProviderId}/${effective.assistant.model}`
      return { content: '执行报告', toolRuns: [] }
    }
    const denied = await collab.runCollaboration({ ...input, confirm: async () => false })
    check('计划拒绝不执行、不验收、不写文件', denied.code === 'PLAN_DENIED' && executions === 0 && reviews === 0 && fs.readFileSync(target, 'utf8') === 'unchanged', JSON.stringify(denied))
    const controller = new AbortController()
    const cancelled = await collab.runCollaboration({ ...input, signal: controller.signal,
      confirm: async () => { controller.abort(); return true } })
    check('批准时取消不执行、不验收', cancelled.code === 'CANCELLED' && executions === 0 && reviews === 0, JSON.stringify(cancelled))
    failPlan = true
    const failed = await chat.runTurn({ payload: { collab: input }, history: [{ role: 'user', content: 'g' }],
      effective: cfg, workdir: root, controller: new AbortController() })
    check('聊天规划失败保留原因、无伪造轮次或工具', failed.content === '没有规划输出' && failed.turns === 0 && failed.toolRuns.length === 0)
    failPlan = false
    const result = await collab.runCollaboration(input)
    check('成功走完规划/执行/验收且由验收给 PASS', result.ok === true && result.accepted === true && executions === 1 && reviews === 1)
    check('没有项目测试登记仍可访问当前对话目录', cfg.projectTests.items.length === 0 && result.ok === true)
    check('A 的指定 provider/model 到达规划与验收调用', plannerRoute === 'collab-test/selected-planner' && reviewRoute === plannerRoute, `${plannerRoute};${reviewRoute}`)
    check('B 的指定 provider/model 到达执行层，不复用全局模型', selectedModel === 'collab-test/selected-worker', selectedModel)
    const same = await collab.runCollaboration({ ...input, executor: input.planner })
    check('同一模型不能伪装成双模型协作', same.code === 'COLLAB_SELECTION_INVALID' && executions === 1)
    const disabled = await collab.runCollaboration({ ...input, selected: false })
    check('当前对话未明确选择时拒绝且不再次执行', disabled.code === 'COLLAB_DISABLED' && executions === 1)
    loop.run = async () => { throw new Error('模拟执行失败') }
    const broken = await collab.runCollaboration(input)
    check('执行失败保留原因，不再进入验收', broken.code === 'EXEC_FAILED' && broken.message === '模拟执行失败' && reviews === 1)
    const singleResult = { content: '单模型结果', turns: 1, toolRuns: [] }
    let singleConfig
    loop.run = async ({ config: effective }) => { singleConfig = effective; return singleResult }
    const single = await chat.runTurn({ payload: {}, history: [{ role: 'user', content: 'g' }],
      effective: cfg, workdir: root, controller: new AbortController(), pause: { requested: false } })
    check('单模型入口原样返回原 loop 结果与配置', single === singleResult && singleConfig === cfg)
  } finally {
    config.get = original.get
    collabCodex.planProjects = original.plan
    collabCodex.reviewResult = original.review
    collabPlanner.planProjects = original.openPlan
    collabPlanner.reviewResult = original.openReview
    loop.run = original.run
    fs.rmSync(root, { recursive: true, force: true })
  }
}
