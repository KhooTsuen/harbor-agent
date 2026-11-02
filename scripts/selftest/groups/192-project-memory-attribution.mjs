/**
 * 自检 / 项目记忆归属闭环（复用评估 §7，2026-11-02）
 *
 * ── 症状 ─────────────────────────────────────────────────────
 *
 * 模型用 `scope: 'project'` 记下的记忆**永远注入不到、也搜不到**。因果链四处：
 *
 *   ① 工具上下文没有 `projectId`（`loop-tool-context.cjs` 只给 workdir/sessionId/taskId）
 *   ② `remember` 写入只传 `sessionId`
 *   ③ `memory-store` 把缺的归属落成 `''`
 *   ④ `memory-scope.visible()` 对 `projectId === ''` fail-closed
 *
 * → 生产库 11 条 `scope=project` 的条目全是空归属（2026-11-02 实测快照）。
 *
 * ── 这一组钉什么 ─────────────────────────────────────────────
 *
 * **真跑**（不是看源码里有没有那行字）：甲 / 乙两个项目 + 一条无项目上下文，
 * 走「写入 → 落盘 → 自动注入 → 模型侧检索」四条路各看一遍。
 *
 * ★ 明确**不**做的事：不救活旧数据。旧条目归属未知，不按内容 / workdir / 会话猜
 *   （上游蓝图 §6）。所以组里专门有一条：模拟的空归属旧条目在同项目上下文里
 *   **仍然不可见**，注入与检索都碰不到它。
 */

import { check, group } from '../harness.mjs'
import { configModule, join, memory, readFileSync, require, ROOT, tools } from '../env.mjs'

const { buildToolContext } = require(join(ROOT, 'electron/core/loop-tool-context.cjs'))
const recall = require(join(ROOT, 'electron/core/memory-recall.cjs'))

const P_A = 'selftest-192-甲'
const P_B = 'selftest-192-乙'
const S_A = 'selftest-192-session-A'
const S_B = 'selftest-192-session-B'
const MARK = 'p192zz'

export async function run() {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
  const spill = []

  /*
   * 用**真的**配置造上下文，只把权限档设成 full（自检里没人在点确认框）。
   * 这样 ctx 的其余字段（allowWrite / allowNetwork / 工具开关）都是生产同一套算法算出来的。
   */
  const base = configModule.get()
  const cfg = { ...base, tools: { ...base.tools, permission: 'full' } }
  const build = (projectId, sessionId) =>
    buildToolContext({
      options: { projectId, sessionId },
      config: cfg,
      workdir: ROOT,
      mode: 'agent',
      threadSettings: {},
      userText: '',
      useProvider: 'openai',
      useModel: 'selftest',
      signal: new AbortController().signal,
      confirm: async () => true,
      emit: () => {},
    })

  group('项目记忆归属 / ① 上下文带着项目 ID（唯一来源）')
  const ctxA = build(P_A, S_A)
  check('★ 工具上下文里有 projectId（以前根本没有这一项）', ctxA.projectId === P_A, String(ctxA.projectId))
  check('会话 ID 没被顺手改坏', ctxA.sessionId === S_A)
  check('★ 没有项目上下文时是空串（fail-closed），不是 undefined', build('', S_A).projectId === '')
  check(
    '★ 写入侧与注入侧读的是同一个字段 options.projectId',
    read('electron/core/loop-tool-context.cjs').includes('projectId: options.projectId') &&
      read('electron/core/loop-prompt.cjs').includes('projectId: options.projectId'),
  )

  group('项目记忆归属 / ② 真跑写入：落盘带项目 ID')
  const wrote = String(
    await tools.execute('remember', { content: `自检临时：甲项目的约定 ${MARK}`, scope: 'project' }, ctxA),
  )
  check('写入被接受', wrote.startsWith('记下了'), wrote)
  const mine = memory
    .list({ includeSuperseded: true })
    .find((i) => String(i.content).includes(MARK) && i.scope === 'project')
  if (mine?.id) spill.push(mine.id)
  check(
    '★ 落盘条目的 projectId 就是当前项目（以前是空串）',
    mine?.projectId === P_A,
    JSON.stringify(mine && { scope: mine.scope, projectId: mine.projectId }),
  )
  check('scope 仍是 project（没被静默降级成 global）', mine?.scope === 'project')

  /* 模拟生产库里那条：scope=project 但归属是空串。写入路径现在不会再产生它了。 */
  const legacy = memory.add({
    content: `自检临时：旧的空归属 ${MARK}`,
    scope: 'project',
    projectId: '',
    sessionId: S_A,
  })
  if (legacy.item?.id) spill.push(legacy.item.id)
  check('旧条目造出来了（projectId 是空串）', legacy.item?.projectId === '')

  group('项目记忆归属 / ③ 模型侧 memory_search：同项目找得到、别项目找不到')
  const search = async (projectId, sessionId = S_A) =>
    String(await tools.execute('memory_search', { query: MARK }, { ...ctxA, projectId, sessionId }))

  const inA = await search(P_A)
  check('★ 甲项目搜得到刚写的那条', inA.includes(String(mine?.id)), inA.slice(0, 200))
  check('★★ 甲项目搜不到旧空归属条目（不猜归属、不救活）', !inA.includes(String(legacy.item?.id)))

  const inB = await search(P_B, S_B)
  check('★★ 乙项目一条项目记忆都搜不到', !inB.includes(String(mine?.id)) && !inB.includes('甲项目的约定'))

  const noProj = await search('', S_A)
  check('★ 没有项目上下文 → 搜不到项目记忆（fail-closed）', !noProj.includes(String(mine?.id)))

  const asAdmin = String(await tools.execute('memory_search', { query: MARK }, { ...ctxA, projectId: undefined }))
  check('★ 工具侧没有「管理视图」后门：不传 projectId 也按无项目处理', !asAdmin.includes(String(mine?.id)))

  group('项目记忆归属 / ④ 自动注入：与检索同一套规则（judge 只有 memory-scope 一处）')
  const injA = recall.retrieve({ query: MARK, projectId: P_A, sessionId: 'selftest-192-session-别的' })
  check('★ 同项目（换一条会话也算）会注入', injA.some((i) => i.id === mine?.id))
  check('★ 旧空归属条目在同项目里仍不注入', !injA.some((i) => i.id === legacy.item?.id))
  check(
    '★★ 别的项目不注入',
    !recall.retrieve({ query: MARK, projectId: P_B, sessionId: S_B }).some((i) => i.id === mine?.id),
  )
  check(
    '★ 没有项目上下文不注入',
    !recall.retrieve({ query: MARK, projectId: '', sessionId: S_A }).some((i) => i.id === mine?.id),
  )
  check(
    '★ 注入与检索都走 memory-scope（没有第二套判断）',
    read('electron/core/memory-recall.cjs').includes('filterVisible') &&
      read('electron/core/memory-store.cjs').includes('filterVisible'),
  )

  group('项目记忆归属 / ⑤ 没有项目 ID 时明说没记，不落死条目')
  const before = memory.list({ includeSuperseded: true }).length
  const refused = String(
    await tools.execute(
      'remember',
      { content: `自检临时：无项目却要记 ${MARK}`, scope: 'project' },
      { ...ctxA, projectId: '' },
    ),
  )
  check('★ 如实说「没记」，且工具结果标为失败', refused.startsWith('错误：没记'), refused)
  const refusedMeta = await tools.execute(
    'remember',
    { content: `自检临时：再次无项目 ${MARK}`, scope: 'project' },
    { ...ctxA, projectId: '', wantMeta: true },
  )
  check(
    '★ 拒写结果带错误前缀，执行器会判为失败',
    typeof refusedMeta === 'string' && refusedMeta.startsWith('错误：没记'),
    JSON.stringify(refusedMeta),
  )
  check(
    '★ 库里没有多出这一条（旧行为是照写，然后永远找不到）',
    memory.list({ includeSuperseded: true }).length === before &&
      !memory.list({ includeSuperseded: true }).some((i) => String(i.content).includes('无项目却要记')),
  )

  group('项目记忆归属 / ⑥ 不按内容或会话猜归属（源码守卫）')
  const storeSrc = read('electron/core/memory-store.cjs')
  check('★ 落盘归属只来自调用方给的 projectId', storeSrc.includes("projectId: String(input.projectId ?? '')"))
  check('★ 没有拿 sessionId / 内容去倒推 projectId', !/projectId\s*[:=][^\n]{0,30}(sessionId|content)/.test(storeSrc))
  check(
    '★ fail-closed 的判据没被改松',
    read('electron/core/memory-scope.cjs').includes(
      "return ctx.projectId !== '' && item.projectId === ctx.projectId",
    ),
  )

  for (const id of spill) memory.remove(id)
  check(
    '测试数据已清理',
    spill.every((id) => !memory.list({ includeSuperseded: true }).some((i) => i.id === id)),
  )
}
