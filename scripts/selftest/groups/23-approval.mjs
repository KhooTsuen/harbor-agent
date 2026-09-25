import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-013：智能权限确认（含 AG-014 的「合并」）

   文档两句话是这条的核心：

     AG-013「[允许本次] [查看 Diff] [拒绝]」+「高风险操作单独确认」
     AG-014「禁止连续弹出大量确认框」

   「允许本次」的**范围**就是实现的关键 —— 这里钉的是它等于**这一轮**，
   而且两件东西**永不记忆**：高危（文档明说单独确认）、路径授权
   （每个路径的风险不一样，批了一个不等于批了全部）。

   还有一条容易漏的：**拒绝之后同类还要问**。不然用户点错一次拒绝，
   后面的都被静默放行了 —— 那比多问几句危险得多。
   ══════════════════════════════════════════════════════════════ */

const approvals = require(join(ROOT, 'electron/core/tools/approval.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('AG-013 · 智能权限确认')

  /* ── 「允许本次」= 本轮同类不再问 ── */
  let asked = 0
  const ctx = {
    granted: new Map(),
    confirm: async () => {
      asked += 1
      return true
    },
  }
  check('第一次要问', (await approvals.ask(ctx, { kind: 'write', name: 'write_file' })) === true)
  check('确实打扰了用户一次', asked === 1)
  check(
    '★ 第二次同类直接放行',
    (await approvals.ask(ctx, { kind: 'write', name: 'edit_file' })) === true,
  )
  check('★ 而且没有再弹框（这就是「禁止连续弹出」）', asked === 1)
  await approvals.ask(ctx, { kind: 'mcp', name: 'some_mcp' })
  check('换一类（mcp）还是要问', asked === 2)

  /* ── 高危永不记忆 ── */
  let riskAsked = 0
  const riskCtx = {
    granted: new Map(),
    confirm: async () => {
      riskAsked += 1
      return true
    },
  }
  await approvals.ask(riskCtx, { kind: 'risk', name: 'run_shell' })
  await approvals.ask(riskCtx, { kind: 'risk', name: 'run_shell' })
  check('★ 高危每次都问（文档：高风险操作单独确认）', riskAsked === 2)

  /* ── 路径授权也不记忆 ── */
  let pathAsked = 0
  const pathCtx = {
    granted: new Map(),
    confirm: async () => {
      pathAsked += 1
      return true
    },
  }
  await approvals.ask(pathCtx, { kind: 'path', name: 'read_file' })
  await approvals.ask(pathCtx, { kind: 'path', name: 'read_file' })
  check('路径授权每次都问（每个路径的风险不同）', pathAsked === 2)

  /* ── 拒绝不记忆 ── */
  let denyAsked = 0
  const denyCtx = {
    granted: new Map(),
    confirm: async () => {
      denyAsked += 1
      return false
    },
  }
  check('拒绝时返回 false', (await approvals.ask(denyCtx, { kind: 'write', name: 'w' })) === false)
  await approvals.ask(denyCtx, { kind: 'write', name: 'w' })
  check('★ 拒绝之后同类还要问（点错一次不能变成静默放行）', denyAsked === 2)

  /* ── 记进任务台账（AG-012 留的 permissions 字段）── */
  const t = taskCore.create({ goal: '权限记录测试', sessionId: 'sess-appr', workdir: ROOT })
  const recCtx = { granted: new Map(), taskId: t.id, confirm: async () => true }
  await approvals.ask(recCtx, { kind: 'write', name: 'write_file' })
  const perms = taskCore.get(t.id)?.permissions ?? []
  check('★ 批准记进了任务的 permissions', perms.length === 1)
  check('记的是哪一类', perms[0]?.kind === 'write')
  await approvals.ask(recCtx, { kind: 'write', name: 'edit_file' })
  const perms2 = taskCore.get(t.id)?.permissions ?? []
  check('靠上面那次批准放行的也记了一笔', perms2.length === 2)

  /* ── 范围 = 时间窗口 ── */
  const loopSrc = readCore('electron/core/loop.cjs')
  const loopToolsSrc = readCore('electron/core/loop-tools.cjs')
  const apprSrc = readCore('electron/core/tools/approval.cjs')
  check(
    '★ 批准记忆建在循环的 ctx 里（跟到任务结束，不是每轮清空）',
    loopSrc.includes('granted: new Map()'),
  )
  check(
    '★ 不是每轮重置 —— 真机测过：每轮清空会弹三次框',
    !loopToolsSrc.includes('ctx.granted = new Set()'),
  )
  check('放行有**时间窗口**（不是永远放行）', apprSrc.includes('GRANT_WINDOW_MS'))

  /* 窗口过期要重新问 —— 直接塞一个旧时间戳，不用真等两分钟 */
  let expiredAsked = 0
  const expiredCtx = {
    granted: new Map([['write', Date.now() - 5 * 60 * 1000]]),
    confirm: async () => {
      expiredAsked += 1
      return true
    },
  }
  await approvals.ask(expiredCtx, { kind: 'write', name: 'w' })
  check('★ 窗口过了要重新问一次', expiredAsked === 1)

  /* ── 四处确认都走统一入口 ── */
  const idxSrc = readCore('electron/core/tools/index.cjs')
  const permSrc = readCore('electron/core/tools/permission.cjs')
  check('index.cjs 三处都改了', (idxSrc.match(/approvals\.ask\(/g) ?? []).length === 3)
  check('permission.cjs 也改了', permSrc.includes('approvals.ask('))
  check(
    '★ 没有漏网的 ctx.confirm 直调（漏一处就等于没合并）',
    !/await ctx\.confirm\(/.test(idxSrc + permSrc),
  )

  /* ── 界面 ── */
  const evSrc = readCore('src/stores/thread/streamEvents.ts')
  check('★ 按钮文案是「允许本次」', evSrc.includes("confirmText: '允许本次'"))
  check('★ 会说明「本轮内不再问」的范围', evSrc.includes('本轮'))
  check('高危在界面上有区别（标题带「高风险」）', evSrc.includes('高风险'))
  check('把 kind 和 risk 传给了界面', evSrc.includes('event.kind') && evSrc.includes('event.risk'))

  /* ══════════════════════════════════════════════════════════
     回归：确认事件必须**还带着对话的 requestId**

     `confirm_request` 的载荷里本来就有个 `requestId`（审批 id `approve_…`）。
     若 emit 把它展开在对话 requestId 之后，渲染层按 requestId 过滤时
     （turns.ts：不匹配就 return）会**把整条确认丢掉** —— 界面永远不弹权限条，
     用户只能干等到超时被当作拒绝。2026-09-25 真机抓到的：事件明明到了
     渲染层，权限条就是不出现。
     ══════════════════════════════════════════════════════════ */
  const chatSrc = readCore('electron/handlers/chat.cjs')
  const emitSrc2 = readCore('electron/core/chat-emit.cjs')
  const { createEmitter } = require(join(ROOT, 'electron/core/chat-emit.cjs'))
  const sent = []
  const em = createEmitter({
    requestId: 'req_chat',
    phaseKey: 'task_probe',
    send: (channel, payload) => sent.push({ channel, payload }),
  })
  let emitErr = null
  try {
    /* 故意让载荷自己带一个 requestId（模拟审批 id 撞车） */
    em.emit({ type: 'confirm_request', confirmId: 'cfm_x', requestId: 'approve_9', summary: 's' })
  } catch (error) {
    emitErr = error
  }
  const ev = sent.find((x) => x.payload?.type === 'confirm_request')
  check('发确认事件不抛错', emitErr === null)
  check('★ confirm_request 发出去了', !!ev)
  check('★ 它的 requestId 还是**对话的**（没被审批 id 顶掉）', ev?.payload?.requestId === 'req_chat')
  check(
    '★ chat-emit 把对话 requestId 写在展开之后（顺序反了就是这个 bug）',
    emitSrc2.includes("{ ...event, requestId }"),
  )
  check(
    '★ askUser 不再拿 requestId 转发审批 id',
    !/requestId: request\.requestId/.test(chatSrc) && chatSrc.includes('approvalId: request.requestId'),
  )

  taskCore.remove(t.id)
  check('测试任务已清理', taskCore.get(t.id) === null)
}
