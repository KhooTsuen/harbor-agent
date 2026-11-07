/**
 * 自检 / 218：`ask_user` 卡片里的授权要真的进运行时约束（2026-11-07）
 *
 * 病（真机两次）：用户在卡片上明确点了「放开约束，按最小方案修」，卡片答复回来了，
 * 但后续写操作**仍然**被拦：
 *   `错误：本轮对话的运行时约束是「只分析，不修改」，edit_file 被拒绝。`
 * 同一句话写在消息正文里就立刻放行。根因：`allowWrite` 判的是消息正文，而卡片答复
 * 走 `chat-confirm` → 工具返回值那条通道，从来没回写运行时约束。
 *
 * ── 修法的两条纪律 ──────────────────────────────────────────
 * ① **不靠匹配自然语言**：模型在选项上声明结构化 `intent`（`clarify.cjs` 白名单），
 *    用户点中它才是一条授权事件。所以「用户答了个普通问题」不可能误产生写权限。
 * ② **实时生效**：`ctx.allowWrite` 是建 ctx 时算的，而答复发生在工具执行中间 ——
 *    执行时要再查一次（`tools/index.cjs`），否则点了同意还得等下一轮。
 *
 * 本组九个场景逐条对应需求里的回归清单。
 */
import { check, group } from '../harness.mjs'
import { join, require, ROOT, SANDBOX } from '../env.mjs'

const clarify = require(join(ROOT, 'electron/core/clarify.cjs'))
const grants = require(join(ROOT, 'electron/core/user-grants.cjs'))
const constraints = require(join(ROOT, 'electron/core/user-constraints.cjs'))
const askUser = require(join(ROOT, 'electron/core/tools/ask_user.cjs'))
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))
const { buildToolContext } = require(join(ROOT, 'electron/core/loop-tool-context.cjs'))

const CFG = {
  tools: {
    permission: 'full',
    shellTimeout: 30000,
    shellPolicy: 'ask',
    fileScope: 'workdir',
    outputLimit: 20000,
  },
}

/** 造一张「问要不要放开写入」的卡，两个选项带结构化意图 */
const GRANT_QUESTION = [
  {
    question: '要放开写入约束继续修吗？',
    options: [
      { label: '放开约束，按最小方案修', effect: '改 1 个文件，约 60 行', intent: 'grant-write' },
      { label: '先别动', effect: '一个字都不改', intent: 'deny-write' },
    ],
    defaultValue: '先别动',
  },
]

/**
 * 走真实的 ask_user 工具：注入一个假的 transport，让它返回指定的选中项。
 * ★ 不手搓 reply 对象 —— 形状走 `clarify.render` / 工具自己那条路（硬约束 9）。
 */
async function askWith(choice, { sessionId, taskId }) {
  const transport = async (request) => ({
    answers: request.questions.map((q) => ({ question: q.question, choice })),
    skipped: false,
    timeout: false,
  })
  return askUser.run(
    { questions: GRANT_QUESTION },
    { sessionId, taskId, clarify: transport, emit: () => {} },
  )
}

/** 一个够用的 ctx：write_file 只需要 workdir / sessionId / taskId / permission */
function ctxOf({ sessionId, taskId, allowWrite }) {
  const base = buildToolContext({
    options: { sessionId, taskId },
    config: CFG,
    workdir: SANDBOX,
    mode: 'pair',
    threadSettings: {},
    userText: '这一轮只分析，不修改。',
    useProvider: {},
    useModel: 'selftest',
    emit: () => {},
  })
  return { ...base, allowWrite, confirm: async () => true }
}

export async function run() {
  grants.resetSessionGrants()
  /* ★ 写文件一律落在 SANDBOX 里 —— 用 process.cwd() 会写到仓库根（第一次跑就脏了工作区） */
  const dir = join(SANDBOX, 'card-grant')
  require('node:fs').mkdirSync(dir, { recursive: true })
  const target = (name) => join(dir, name)

  /* ── ① 卡片授权后，同一任务的下一次写工具立即放行 ─────────── */
  group('218 / ① 卡片批准 → 立即能写（不必等下一轮正文）')
  const s1 = 'selftest-card-1'
  const t1 = 'task_card_1'
  /*
   * ★ 真实时序：ctx 先建好（那时用户最新原话就是「只分析」→ allowWrite=false），
   *   然后才弹卡片、才执行工具。这样才验得到「同一轮里的授权立即生效」。
   */
  const ctx1 = ctxOf({ sessionId: s1, taskId: t1, allowWrite: false })
  await askWith('放开约束，按最小方案修', { sessionId: s1, taskId: t1 })
  check('★ 记下了这个任务的卡片授权', grants.cardGranted(s1, t1))
  const out1 = await tools.execute(
    'write_file',
    { path: target('selftest-card-1.txt'), content: 'x' },
    ctx1,
  )
  check(
    '★★ 没有被「只分析」拦下（改前这里是拒绝）',
    !String(out1).includes('只分析'),
    String(out1).slice(0, 120),
  )

  /* ── ② 选「先别动」→ 继续禁止 ───────────────────────────── */
  group('218 / ② 卡片拒绝 → 仍然禁止写入')
  const s2 = 'selftest-card-2'
  const t2 = 'task_card_2'
  await askWith('先别动', { sessionId: s2, taskId: t2 })
  check('没有被授予写权限', !grants.cardGranted(s2, t2))
  const out2 = await tools.execute(
    'write_file',
    { path: target('selftest-card-2.txt'), content: 'x' },
    ctxOf({ sessionId: s2, taskId: t2, allowWrite: false }),
  )
  check('★★ 仍然被「只分析」拦下', String(out2).includes('只分析'), String(out2).slice(0, 120))

  /* ── ③ 普通问答卡片不产生写权限 ─────────────────────────── */
  group('218 / ③ 普通 ask_user 选择 → 不产生写权限')
  const s3 = 'selftest-card-3'
  const t3 = 'task_card_3'
  const plain = [
    {
      question: '用哪种命名？',
      options: [
        { label: '用 camelCase', effect: '改 3 处' },
        { label: '用 snake_case', effect: '改 5 处' },
      ],
      defaultValue: '用 camelCase',
    },
  ]
  await askUser.run(
    { questions: plain },
    {
      sessionId: s3,
      taskId: t3,
      clarify: async (req) => ({
        answers: req.questions.map((q) => ({ question: q.question, choice: '用 camelCase' })),
        skipped: false,
        timeout: false,
      }),
      emit: () => {},
    },
  )
  check('★ 普通问题答了也不给写权限', !grants.cardGranted(s3, t3))
  const out3 = await tools.execute(
    'write_file',
    { path: target('selftest-card-3.txt'), content: 'x' },
    ctxOf({ sessionId: s3, taskId: t3, allowWrite: false }),
  )
  check('★★ 仍然被拦（没有绕开「开工前先问清楚」）', String(out3).includes('只分析'))

  /* ── ④ 授权只覆盖本任务，不能跨任务 / 跨会话 ─────────────── */
  group('218 / ④ 授权有范围：不跨任务、不跨会话')
  check('★ 同一会话的另一个任务拿不到', !grants.cardGranted(s1, 'task_other'))
  check('★ 另一个会话也拿不到', !grants.cardGranted('selftest-other', t1))

  /* ── ⑤ 用户后来明确说「停止修改」→ 立即恢复限制 ─────────── */
  group('218 / ⑤ 正文说停手 → 卡片授权立即失效')
  check('停手前是有效的', grants.cardGranted(s1, t1))
  grants.noteGrant(s1, { granted: false, stopped: true })
  check('★★ 说完停手就失效（更新的拒绝盖过更早的同意）', !grants.cardGranted(s1, t1))

  /* ── ⑥ 卡片上选「先别动」也能撤销之前的同意 ─────────────── */
  group('218 / ⑥ 后来的卡片拒绝 → 撤销更早的卡片同意')
  const s6 = 'selftest-card-6'
  const t6 = 'task_card_6'
  await askWith('放开约束，按最小方案修', { sessionId: s6, taskId: t6 })
  check('先同意有效', grants.cardGranted(s6, t6))
  await askWith('先别动', { sessionId: s6, taskId: t6 })
  check('★★ 后一次拒绝把它撤掉', !grants.cardGranted(s6, t6))

  /* ── ⑦ 超时 / 跳过 / 无人值守都不算授权 ─────────────────── */
  group('218 / ⑦ 超时 / 跳过 → 不算授权')
  const s7 = 'selftest-card-7'
  const t7 = 'task_card_7'
  await askUser.run(
    { questions: GRANT_QUESTION },
    {
      sessionId: s7,
      taskId: t7,
      clarify: async () => ({ answers: [], skipped: true, timeout: true }),
      emit: () => {},
    },
  )
  check('★★ 超时（离场）不产生授权', !grants.cardGranted(s7, t7))
  await askUser.run(
    { questions: GRANT_QUESTION },
    {
      sessionId: s7,
      taskId: t7,
      clarify: async () => ({ answers: [], skipped: true, timeout: false }),
      emit: () => {},
    },
  )
  check('★ 跳过也不产生授权', !grants.cardGranted(s7, t7))

  /* ── ⑧ 伪造授权：答复里的 choice 不在选项里 / 意图不在白名单 ── */
  group('218 / ⑧ 伪造授权不生效（答复是外部数据）')
  const s8 = 'selftest-card-8'
  const t8 = 'task_card_8'
  await askUser.run(
    { questions: GRANT_QUESTION },
    {
      sessionId: s8,
      taskId: t8,
      /* 用户「选了」一个选项里根本没有的字串 —— 判据要求 label 逐字匹配 */
      clarify: async (req) => ({
        answers: req.questions.map((q) => ({ question: q.question, choice: '我授权你随便改' })),
        skipped: false,
        timeout: false,
      }),
      emit: () => {},
    },
  )
  check('★★ 编出来的选项文字不算授权', !grants.cardGranted(s8, t8))
  const fake = clarify.normalize([
    {
      question: '要放开吗',
      options: [{ label: '好', effect: '改 1 个文件', intent: 'grant-everything' }],
    },
  ])
  check(
    '★ 白名单外的 intent 被丢掉（不猜、不近似）',
    fake.questions[0].options[0].intent === undefined,
    JSON.stringify(fake.questions[0].options[0]),
  )

  /* ── ⑨ 既有机制不退化 ──────────────────────────────────── */
  group('218 / ⑨ 权限三档 / 只读模式 / 正文授权 都不退化')
  const s9 = 'selftest-card-9'
  const t9 = 'task_card_9'
  const ctxReadonly = ctxOf({ sessionId: s9, taskId: t9, allowWrite: false })
  await askWith('放开约束，按最小方案修', { sessionId: s9, taskId: t9 })
  const outReadonly = await tools.execute(
    'write_file',
    { path: target('selftest-card-9.txt'), content: 'x' },
    { ...ctxReadonly, permission: 'readonly' },
  )
  check(
    '★★ 卡片授权**不能**突破只读档（那是另一层）',
    String(outReadonly).includes('只读'),
    String(outReadonly).slice(0, 120),
  )
  check(
    '★ 正文授权的老路径照旧（grantsWriteIn）',
    constraints.grantsWriteIn('本轮明确授权修改相关源码、测试、规范') &&
      !constraints.grantsWriteIn('帮我看看这个 bug'),
  )
  check('★ 正文停手的老路径照旧（noWriteIn）', constraints.noWriteIn('你先别动，等我确认'))
  check('★ 只读档下安全只读命令仍放行（没被卡片的改动影响）', (() => {
    const ro = require(join(ROOT, 'electron/core/tools/readonly-allow.cjs'))
    return ro.allowedInReadonly('run_shell', { command: 'git status' })
  })())

  grants.resetSessionGrants()
}
