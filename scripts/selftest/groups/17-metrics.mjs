import { join, require, ROOT, readFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-003 任务时间线埋点

   文档要的是「用户发送后必须**立即**获得反馈」，并且把这件事量出来：
   六个时刻、三个指标（TTFT / First Tool Feedback / Total Duration）。

   这一组要钉死的：

     · 六个时刻各自认领的是哪条事件（认错就等于指标是错的）
     · **同一个时刻只记第一次**（第三个 token 不算 TTFT）
     · 首反馈 = 第一条事件（不管是什么事件）
     · `content` 和 `reasoning` 都算「模型开始吐字」—— 纯推理模型可能先出思考
     · 算完就清内存、发一条 metrics.timeline（要落盘，事后能查）
     · 异常退出时 completion 兜底，别丢整条数据
   ══════════════════════════════════════════════════════════════ */

const metrics = require(join(ROOT, 'electron/core/metrics.cjs'))
const bus = require(join(ROOT, 'electron/core/events.cjs'))

const TAG = `selftest-metrics-${process.pid}`
const T0 = 1_700_000_000_000

export async function run() {
  group('AG-003 埋点 / 六个时刻')
  metrics.clear()
  const t = metrics.begin(TAG, { requestTime: T0 })
  check('begin 记下 requestTime', t.requestTime === T0)
  check('其余时刻一开始是 0', t.taskCreated === 0 && t.firstToken === 0 && t.completion === 0)

  metrics.observe(TAG, { type: 'task' }, T0 + 10)
  check('task 事件认领 taskCreated', metrics.get(TAG).taskCreated === T0 + 10)

  metrics.observe(TAG, { type: 'agent.started' }, T0 + 12)
  check('★ 首反馈 = 第一条事件（不管是什么事件）', metrics.get(TAG).firstFeedback === T0 + 10)

  metrics.observe(TAG, { type: 'content', text: 'a' }, T0 + 900)
  check('content 认领 firstToken', metrics.get(TAG).firstToken === T0 + 900)

  /* 第二次不该再改 —— 否则「首个 token 延迟」会变成「最后一个 token 延迟」 */
  metrics.observe(TAG, { type: 'content', text: 'b' }, T0 + 1500)
  check(
    '★ 同一个时刻只记第一次（第三个 token 不算 TTFT）',
    metrics.get(TAG).firstToken === T0 + 900,
  )

  metrics.observe(TAG, { type: 'agent.tool.started', name: 'read_file' }, T0 + 2000)
  check('agent.tool.started 认领 firstTool', metrics.get(TAG).firstTool === T0 + 2000)
  metrics.observe(TAG, { type: 'agent.tool.started', name: 'run_shell' }, T0 + 2500)
  check('后续工具不覆盖首次工具', metrics.get(TAG).firstTool === T0 + 2000)

  group('AG-003 埋点 / 三种结束方式')
  metrics.observe(TAG, { type: 'agent.completed' }, T0 + 4000)
  check('agent.completed 认领 completion', metrics.get(TAG).completion === T0 + 4000)

  for (const type of ['agent.failed', 'agent.cancelled']) {
    const id = `${TAG}-${type}`
    metrics.begin(id, { requestTime: T0 })
    metrics.observe(id, { type }, T0 + 100)
    const r = metrics.finish(id)
    check(`${type} 也算结束（三种结束方式都不能漏）`, r.completion === T0 + 100)
  }

  group('AG-003 埋点 / 指标计算')
  const report = metrics.finish(TAG)
  check('算出 TTFT', report.ttftMs === 900, String(report.ttftMs))
  check('算出首次工具反馈', report.firstToolMs === 2000, String(report.firstToolMs))
  check('算出总耗时', report.totalMs === 4000, String(report.totalMs))
  check('算出首反馈延迟', report.firstFeedbackMs === 10, String(report.firstFeedbackMs))
  check('算出建任务延迟', report.taskCreatedMs === 10, String(report.taskCreatedMs))
  check('finish 之后清掉内存（不囤历史）', metrics.get(TAG) === null)

  group('AG-003 埋点 / reasoning 也算吐字')
  const rid = `${TAG}-reasoning`
  metrics.begin(rid, { requestTime: T0 })
  metrics.observe(rid, { type: 'reasoning', text: '嗯' }, T0 + 500)
  check(
    '★ reasoning 算 firstToken（纯推理模型可能先出思考）',
    metrics.get(rid).firstToken === T0 + 500,
  )
  metrics.finish(rid)

  group('AG-003 埋点 / 兜底与清理')
  const cid = `${TAG}-crash`
  metrics.begin(cid, { requestTime: T0 })
  metrics.observe(cid, { type: 'content', text: 'x' }, T0 + 100)
  const crashed = metrics.finish(cid)
  check(
    '★ 异常退出时 completion 兜底（不丢整条数据）',
    crashed.completion > 0 && crashed.totalMs !== null,
  )

  check('没 begin 就 observe 不炸', (metrics.observe('不存在的', { type: 'content' }), true))
  check('没 begin 就 finish 返回 null', metrics.finish('不存在的') === null)
  check('traceId 为空时不记（不建匿名坑）', metrics.begin('', { requestTime: T0 }) === null)

  metrics.clear()
  for (let i = 0; i < metrics.MAX_PENDING + 20; i += 1) {
    metrics.begin(`${TAG}-cap-${i}`, { requestTime: T0 })
  }
  check('★ 待办时间线有上限（不无限囤内存）', metrics.get(`${TAG}-cap-0`) === null)
  check('最新的还在', metrics.get(`${TAG}-cap-${metrics.MAX_PENDING + 19}`) !== null)
  metrics.clear()

  group('AG-003 埋点 / 落盘与接线')
  bus.clear()
  const did = `${TAG}-disk`
  metrics.begin(did, { requestTime: T0 })
  metrics.observe(did, { type: 'content' }, T0 + 100)
  metrics.finish(did)
  const emitted = bus.recent(20).filter((e) => e.type === 'metrics.timeline')
  check('finish 发一条 metrics.timeline 事件', emitted.length === 1)
  check('★ 指标事件要落盘（显式 persist，事后查得到）', emitted[0]?.taskId === did)

  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check('★ chat.cjs 在请求开始时 begin', chatSrc.includes('metrics.begin(phaseKey'))
  check(
    '★ chat.cjs 每条事件都过 observe（不用各模块各插埋点）',
    chatSrc.includes('metrics.observe(phaseKey, event)'),
  )
  check('★ chat.cjs 收尾时 finish', chatSrc.includes('metrics.finish(phaseKey)'))
  check(
    '★ 没配供应商那条提前返回的路径也 finish 了（不然内存里留一条）',
    chatSrc.includes('metrics.finish(phaseKey)\n      return { ok: false'),
  )

  const turnsSrc = readFileSync(join(ROOT, 'src/stores/thread/turns.ts'), 'utf8')
  check('★ 前端把「按下发送」的时刻带给主进程', turnsSrc.includes('requestTime,'))
  check(
    'requestTime 是在函数最开始取的（不是发 IPC 之前）',
    /const requestTime = Date\.now\(\)[\s\S]{0,120}const app = useAppStore/.test(turnsSrc),
  )

  const hookSrc = readFileSync(join(ROOT, 'src/hooks/useAgentActive.ts'), 'utf8')
  check(
    '★ 「在跑」= 本地已提交 || 后台在跑（两个来源缺一不可）',
    hookSrc.includes('localPending || isActivePhase(phase)'),
  )
  check('本地已提交看 sendingThreads', hookSrc.includes('sendingThreads.includes'))
}
