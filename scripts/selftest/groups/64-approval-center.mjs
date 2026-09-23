import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   审批统一生命周期（Approval Center）

   这一段钉三件事：

     ① 每条审批**带 scope** —— 这次批准管到哪儿（一次性 / 本会话 / 永久）。
        以前一律记成 `once`，界面因而看不出「这条是永久授权」，
        也就没法只给永久的那几条配「撤销」。
     ② `approval.list()` **最新在前**，且旧记录（缺 id / scope）不会把读口带崩。
     ③ `approvals:revoke` 对**一次性审批**明说不行（带原因），只对永久授权真撤。

   ③ 是重点：一个「点上去没反应」的撤销按钮，比没有按钮更糟。

   ⚠️ 本组**故意没有注册进 `scripts/selftest.mjs`**（按任务要求），
      单独跑法见交付说明。register 那一段用假 ipcMain 真跑一遍安全 handler ——
      纯文本断言挡不住「把注册那行注释掉」，而 channelsMissing 只会在打包后才报。
   ══════════════════════════════════════════════════════════════ */

const approval = require(join(ROOT, 'electron/core/tools/approval.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const capability = require(join(ROOT, 'electron/core/capability.cjs'))
const safetyHandler = require(join(ROOT, 'electron/handlers/safety.cjs'))

/** 真注册一遍 safety.cjs 的 handler，返回「通道 → 调用一下」的函数（不需要 electron） */
function fakeIpc() {
  const handlers = new Map()
  safetyHandler.register({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } })
  return (channel, arg) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`没注册这个通道：${channel}`)
    return handler(null, arg)
  }
}

const permanentCount = () =>
  capability.list().filter((grant) => grant.mode === 'permanent').length

export async function run() {
  group('审批统一生命周期（Approval Center）')

  const task = taskCore.create({
    goal: '审批中心测试',
    sessionId: 'sess-approval-center',
    workdir: ROOT,
  })
  const ctx = { granted: new Map(), taskId: task.id, confirm: async () => true }

  /* ── ① scope 被记下来 ── */
  await approval.ask(ctx, { kind: 'path', name: 'C:/outside/a.txt', scope: 'session' })
  check(
    '★ scope 记进了台账（session）',
    approval.list({ taskId: task.id })[0]?.scope === 'session',
    String(approval.list({ taskId: task.id })[0]?.scope),
  )

  await approval.ask(ctx, { kind: 'path', name: 'C:/outside/b.txt' })
  check('不传 scope 缺省是一次性（once）', approval.list({ taskId: task.id })[0]?.scope === 'once')

  await approval.ask(ctx, { kind: 'path', name: 'C:/outside/c.txt', scope: 'permanent' })
  check('permanent 原样记住', approval.list({ taskId: task.id })[0]?.scope === 'permanent')

  await approval.ask(ctx, { kind: 'path', name: 'C:/outside/d.txt', scope: '没这一档' })
  check(
    '★ 认不出来的 scope 归一成一次性（这条路上只能往「多问」的方向错）',
    approval.list({ taskId: task.id })[0]?.scope === 'once',
  )

  /* ── ② 最新在前 + 字段齐 ── */
  const rows = approval.list({ taskId: task.id })
  const names = rows.map((row) => row.name)
  check(
    '★ list 最新在前（不是台账的追加顺序）',
    names[0] === 'C:/outside/d.txt' && names[names.length - 1] === 'C:/outside/a.txt',
    names.join(' | '),
  )
  check(
    '每行字段正好七项',
    JSON.stringify(Object.keys(rows[0] ?? {}).sort()) ===
      JSON.stringify(['approved', 'at', 'kind', 'name', 'requestId', 'scope', 'timedOut']),
    JSON.stringify(Object.keys(rows[0] ?? {})),
  )
  check('requestId 在（界面/日志靠它对上同一条）', String(rows[0]?.requestId).startsWith('approve_'))
  check('at 是时间戳', typeof rows[0]?.at === 'number' && rows[0].at > 0)
  check('approved 是布尔', rows[0]?.approved === true)
  check('没超时就不该标 timedOut', rows[0]?.timedOut === false)

  /* 旧记录：加 requestId / scope 之前写的那些，读口不能崩 */
  const legacy = taskCore.get(task.id)?.permissions ?? []
  taskCore.update(task.id, {
    permissions: [...legacy, { at: Date.now(), kind: 'write', name: '老记录.txt', approved: true }],
  })
  const legacyRow = approval.list({ taskId: task.id })[0]
  check(
    '★ 旧记录（没有 requestId / scope）也读得出来',
    legacyRow?.requestId === '' && legacyRow?.scope === 'once',
    JSON.stringify(legacyRow),
  )

  /* ── ③ IPC：聚合 + 撤销 ── */
  const call = fakeIpc()
  const listed = call('approvals:list', { taskId: task.id })
  check('approvals:list 点名了 taskId 就用它', listed.taskId === task.id)
  check(
    '台账里的审批带 source: task',
    listed.items.some((item) => item.source === 'task' && item.revocable === false),
  )
  check(
    '★ 聚合结果也最新在前',
    listed.items.every((item, index) => index === 0 || listed.items[index - 1].at >= item.at),
    listed.items.map((item) => item.at).join(','),
  )

  /* 一次性审批：撤不掉，而且要说清楚为什么 */
  const onceRevoke = call('approvals:revoke', 'C:/outside/a.txt')
  check(
    '★ 一次性审批返回不可撤销（带原因）',
    onceRevoke.ok === false && onceRevoke.reason === '一次性审批无法撤销，只能撤销永久授权',
    JSON.stringify(onceRevoke),
  )

  /* 永久授权：能撤，撤完就从表里消失 */
  const outside = join(ROOT, 'package.json')
  const before = permanentCount()
  capability.grant(outside, { mode: 'permanent', reason: '自检：审批中心' })
  const grantRow = call('approvals:list', { taskId: task.id }).items.find(
    (item) => item.source === 'capability',
  )
  check(
    '★ 永久路径授权也进了这张表（source: capability）',
    grantRow?.name === capability.realpath(outside) && grantRow?.revocable === true,
    JSON.stringify(grantRow),
  )
  check('它的 scope 标成 permanent', grantRow?.scope === 'permanent')

  const revoked = call('approvals:revoke', grantRow?.name ?? '')
  check('★ 永久授权撤得掉', revoked.ok === true, JSON.stringify(revoked))
  check('真的从授权文件里少了一条', permanentCount() === before)
  check(
    '撤完就不在表里了',
    !call('approvals:list', { taskId: task.id }).items.some((item) => item.name === grantRow?.name),
  )

  /* ── 注册是真的（不是注释掉的那一行）── */
  const safetySrc = readFileSync(join(ROOT, 'electron/handlers/safety.cjs'), 'utf8')
  check(
    '两个通道都注册了',
    safetySrc.includes("ipcMain.handle('approvals:list'") &&
      safetySrc.includes("ipcMain.handle('approvals:revoke'"),
  )
  check(
    '审批的作用范围只有三档',
    JSON.stringify(approval.SCOPES) === JSON.stringify(['once', 'session', 'permanent']),
  )

  /* ── 收尾：测试任务删掉，别留在用户的台账里 ── */
  capability.revoke(outside)
  taskCore.remove(task.id)
  check('测试任务已清理', taskCore.get(task.id) === null)
}
