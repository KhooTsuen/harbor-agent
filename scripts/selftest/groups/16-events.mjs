import { join, require, ROOT, existsSync, readFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-002 统一 Event Bus

   这一组盯的是「事件只能有一个来源、一套名字」。改造前每个模块自己
   `send('chat:event', {...})`、名字各起各的，想还原「这一轮发生了什么」
   得挨个模块翻。

   要钉死的边界：

     · 16 个标准事件名，和需求文档一字不差
     · 结构固定 `{eventId, taskId, timestamp, type, payload}`
     · 状态机转移 → 标准事件名（映射表不许出现文档外的名字）
     · 环形缓冲：进程内的 UI / 日志 / Task Center 看同一份
     · **只有 agent.\* 落盘** —— content 增量一条消息几万个，落盘会写爆磁盘
     · 事件系统是旁路：订阅者抛错、落盘失败，都不能影响主流程
   ══════════════════════════════════════════════════════════════ */

const events = require(join(ROOT, 'electron/core/events.cjs'))
const life = require(join(ROOT, 'electron/core/lifecycle.cjs'))

/** 需求文档 AG-002 列的 16 个标准事件，抄写时逐字比对 */
const DOC_EVENTS = [
  'agent.started',
  'agent.thinking',
  'agent.planning',
  'agent.tool.started',
  'agent.tool.progress',
  'agent.tool.completed',
  'agent.tool.failed',
  'agent.verification.started',
  'agent.verification.completed',
  'agent.waiting_user',
  'agent.retrying',
  'agent.paused',
  'agent.resumed',
  'agent.cancelled',
  'agent.completed',
  'agent.failed',
]

/** 给测试事件打标记，免得和别的用例（或真实运行）混在一起 */
const TAG = `selftest-events-${process.pid}`

function todayFile() {
  return join(events.eventsDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`)
}

function diskLines() {
  const file = todayFile()
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.includes(TAG))
}

export async function run() {
  group('AG-002 事件总线 / 标准事件名')
  check('恰好 16 个标准事件', events.AGENT_EVENTS.length === 16)
  check(
    '和需求文档 AG-002 一字不差',
    DOC_EVENTS.every((name) => events.AGENT_EVENTS.includes(name)) &&
      events.AGENT_EVENTS.every((name) => DOC_EVENTS.includes(name)),
  )
  check(
    '全都在 agent. 命名空间下（一眼能认出是生命周期事件）',
    events.AGENT_EVENTS.every((name) => name.startsWith('agent.')),
  )

  group('AG-002 事件总线 / 相位映射')
  const mapped = Object.keys(events.PHASE_TO_EVENT)
  check(
    '★ 映射的键都是真实存在的相位（错一个就是接线断了）',
    mapped.every((p) => life.PHASES.includes(p)),
  )
  check(
    '★ 映射的值都是标准事件名（不许现编）',
    Object.values(events.PHASE_TO_EVENT).every((name) => events.AGENT_EVENTS.includes(name)),
  )
  check('idle 不发事件（什么也没发生，发出来只是噪音）', !('idle' in events.PHASE_TO_EVENT))
  check('executing 不发粗粒度事件（agent.tool.* 更细）', !('executing' in events.PHASE_TO_EVENT))

  group('AG-002 事件总线 / 转移 → 事件')
  const t = events.eventForTransition
  check('thinking → agent.thinking', t('preparing', 'thinking') === 'agent.thinking')
  check('planning → agent.planning', t('thinking', 'planning') === 'agent.planning')
  check(
    '进入 verifying → agent.verification.started',
    t('executing', 'verifying') === 'agent.verification.started',
  )
  check(
    '★ 离开 verifying 进 responding → agent.verification.completed',
    t('verifying', 'responding') === 'agent.verification.completed',
  )
  check(
    '★ 从 paused 出去 → agent.resumed（恢复要看得见）',
    t('paused', 'thinking') === 'agent.resumed',
  )
  check('paused → executing 也算恢复', t('paused', 'executing') === 'agent.resumed')
  check(
    'executing → executing 不发事件（一轮里会来回很多次）',
    t('executing', 'executing') === null,
  )
  check('idle → preparing 发 agent.started', t('idle', 'preparing') === 'agent.started')
  check(
    'completed / failed / cancelled 各有对应事件',
    [t('responding', 'completed'), t('thinking', 'failed'), t('responding', 'cancelled')].join(
      ',',
    ) === 'agent.completed,agent.failed,agent.cancelled',
  )
  check(
    '★ 所有转移产出的名字都是标准名',
    life.PHASES.every((a) =>
      life.PHASES.every((b) => {
        const name = t(a, b)
        return name === null || events.AGENT_EVENTS.includes(name)
      }),
    ),
  )

  group('AG-002 事件总线 / 结构')
  const one = events.emit('agent.thinking', { note: 'x' }, { taskId: TAG })
  check('有 eventId', typeof one.eventId === 'string' && one.eventId.startsWith('evt_'))
  check(
    'eventId 唯一',
    new Set(
      Array.from({ length: 50 }, () => events.emit('agent.thinking', {}, { taskId: TAG }).eventId),
    ).size === 50,
  )
  check('带 taskId', one.taskId === TAG)
  check('timestamp 是数字', typeof one.timestamp === 'number' && one.timestamp > 0)
  check('type 是原样传进来的', one.type === 'agent.thinking')
  check('payload 原样保留', one.payload.note === 'x')
  check(
    '不给 payload 时是空对象（不是 undefined）',
    events.emit('agent.started', undefined, { taskId: TAG }).payload !== undefined,
  )
  check(
    'type 传空 → 记成 unknown（不静默丢）',
    events.emit('', {}, { taskId: TAG }).type === 'unknown',
  )

  group('AG-002 事件总线 / 订阅')
  const seen = []
  const off = events.on((e) => seen.push(e.eventId))
  events.emit('agent.thinking', {}, { taskId: TAG })
  check('订阅者收到事件', seen.length === 1)
  off()
  events.emit('agent.thinking', {}, { taskId: TAG })
  check('取消订阅后收不到', seen.length === 1)

  const seen2 = []
  const offBad = events.on(() => {
    throw new Error('订阅者炸了')
  })
  const offOk = events.on((e) => seen2.push(e.eventId))
  let survived = true
  try {
    events.emit('agent.thinking', {}, { taskId: TAG })
  } catch {
    survived = false
  }
  check('★ 一个订阅者抛错不影响别人，也不影响主流程', survived && seen2.length === 1)
  offBad()
  offOk()

  group('AG-002 事件总线 / 环形缓冲')
  events.clear()
  for (let i = 0; i < events.RING_SIZE + 40; i += 1) {
    events.emit('agent.thinking', { i }, { taskId: TAG, persist: false })
  }
  check('缓冲不超过上限', events.recent(9999).length === events.RING_SIZE)
  check('recent(n) 取的是最近 n 条', events.recent(5).length === 5)
  check('recent 拿到的是最后发的', events.recent(1)[0].payload.i === events.RING_SIZE + 39)
  events.clear()
  check('clear 清空缓冲', events.recent(10).length === 0)

  group('AG-002 事件总线 / 落盘')
  const before = diskLines().length
  events.emit('agent.started', { note: 'disk' }, { taskId: TAG })
  const afterAgent = diskLines().length
  check('★ agent.* 会落盘（诊断包要靠它还原现场）', afterAgent === before + 1)

  events.emit('content', { text: '啊'.repeat(5000) }, { taskId: TAG })
  events.emit('reasoning', { text: '嗯' }, { taskId: TAG })
  check('★ 流式增量不落盘（一条回答几万个，落盘会写爆磁盘）', diskLines().length === afterAgent)

  events.emit(
    'agent.thinking',
    { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345', token: 'x' },
    { taskId: TAG },
  )
  const raw = diskLines().join('\n')
  check('★ 落盘内容过脱敏（密钥不能进磁盘）', !raw.includes('sk-abcdefghijklmnopqrstuvwxyz012345'))

  group('AG-002 事件总线 / 接线守卫')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check(
    '★ chat.cjs 的相位转移用 eventForTransition 取名（不是现编字符串）',
    chatSrc.includes('eventForTransition'),
  )
  check('chat.cjs 用的是统一总线', chatSrc.includes('core/events.cjs'))
  const toolsSrc = readFileSync(join(ROOT, 'electron/core/loop-tools.cjs'), 'utf8')
  check('★ 工具事件用标准名 agent.tool.started', toolsSrc.includes("'agent.tool.started'"))
  check('★ 工具成功用 agent.tool.completed', toolsSrc.includes("'agent.tool.completed'"))
  check(
    '★ 工具失败用 agent.tool.failed（名字里就带成败，前端不用再判）',
    toolsSrc.includes("'agent.tool.failed'"),
  )
  check('★ 旧名 tool_start 不再出现在工具执行里', !toolsSrc.includes("type: 'tool_start'"))
  check('★ 旧名 tool_end 不再出现在工具执行里', !toolsSrc.includes("type: 'tool_end'"))

  /*
   * 这条是**真踩过的坑**：loop.run 内部会把 options.taskId 换成任务台账的 id
   * （runLoop({...options, taskId: task.id})），而调用方订阅状态转移用的是
   * 自己那个 key（requestId）—— 两边对不上，事件就被全部过滤掉。
   * 表现是「UI 一直显示空闲，后台其实在跑」，测试全绿也看不出来。
   */
  const loopSrc = readFileSync(join(ROOT, 'electron/core/loop.cjs'), 'utf8')
  check(
    '★ 状态事件用 traceKey（不能拿任务台账 id 当事件 key）',
    loopSrc.includes('function traceKey'),
  )
  check('★ 所有 life.mark 都走 traceKey，没有残留的 tid', !/life\.mark\([^)]*tid/.test(loopSrc))
  check('chat.cjs 传了 traceId', chatSrc.includes('traceId: phaseKey'))

  events.clear()
}
