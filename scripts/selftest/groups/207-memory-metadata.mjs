/**
 * 自检 / 207 —— 记忆的元数据在「整段覆盖写入」之后必须还在（P1，2026-11-05）
 *
 * ── 起因（探针实测，不是读代码猜的） ─────────────────────────────
 *
 * `memory.write(text)` 是设置页那段 textarea 与「清空旧版整篇」共用的入口，
 * 以前它是「无条件停用全部 active，再把每一行 `add` 成 fact/global」：
 *
 *   3 条（preference / project_rule / fact，其中一条带 projectId、一条带 sessionId）
 *   过一遍 `write(read())` 之后 —— active 从 3 变成 6~9 条，而
 *   type 只剩 `fact`、scope 只剩 `global`、sessionId 全是空串、projectId 全空。
 *
 * 后果不是「少了个字段」，是两件用户能感觉到的事：
 *   · 偏好 / 约束 / 项目规则降级成事实 —— `memory-explain` 的权重表里不再优先遵守；
 *   · 会话 / 项目作用域的记忆变成**全局可见** —— 该藏的反倒藏不住了（SEC-065）。
 *
 * 所以本组钉的是「盘上那几行元数据」和「可见性」两件事，不钉函数签名。
 *
 * ── 第二个已知形状：重复内容不覆盖类型 ──────────────────────────
 *
 * `store.add` 遇到同内容只更新 `lastUsedAt` 就返回（deduped）。**这是刻意的**：
 * 覆盖 scope 会改可见性（一条 global 被改成 session 就在别的会话消失）。
 * 但上层以前把 `deduped` 丢了，`remember` 一律回「记下了」——
 * 模型以为类型改了，实际没改。现在要求**如实说**（断言里钉文案的关键词）。
 */

import { check, group } from '../harness.mjs'
import { ROOT, join, require as req, readFileSync, memory } from '../env.mjs'

const store = req(join(ROOT, 'electron/core/memory-store.cjs'))
const remember = req(join(ROOT, 'electron/core/tools/remember.cjs'))

/** 直接读盘上那份 memory.json —— 断言要落在**落盘结果**上，不是返回值 */
function rawItems() {
  try {
    const parsed = JSON.parse(readFileSync(store.filePath(), 'utf8'))
    return Array.isArray(parsed.items) ? parsed.items : []
  } catch {
    return []
  }
}

export async function run() {
  /* ═══════════ ① 写入链路：四条元数据都要落到盘上 ═══════════ */
  group('207 / ① remember 链路：type / scope / sessionId / projectId 完整落盘')
  memory.clear()

  await remember.run(
    { content: '自检 207：用户偏好短回答', type: 'preference', scope: 'global' },
    { sessionId: 's207-a' },
  )
  await remember.run(
    { content: '自检 207：项目里不要用 any', type: 'project_rule', scope: 'project' },
    { sessionId: 's207-a', projectId: 'proj-207' },
  )
  await remember.run(
    { content: '自检 207：这次对话里说的不吃香菜', type: 'fact', scope: 'session' },
    { sessionId: 's207-a' },
  )

  const items = rawItems()
  const pref = items.find((i) => i.content.includes('短回答'))
  const rule = items.find((i) => i.content.includes('不要用 any'))
  const sess = items.find((i) => i.content.includes('不吃香菜'))

  check('type 落到盘上', pref?.type === 'preference' && rule?.type === 'project_rule', `${pref?.type} / ${rule?.type}`)
  check('scope 落到盘上', pref?.scope === 'global' && rule?.scope === 'project' && sess?.scope === 'session', `${pref?.scope} / ${rule?.scope} / ${sess?.scope}`)
  check('project 作用域带 projectId', rule?.projectId === 'proj-207', String(rule?.projectId))
  check('session 作用域带 sessionId', sess?.sessionId === 's207-a', String(sess?.sessionId))
  check('global 不落一个用不上的 projectId', pref?.projectId === '', JSON.stringify(pref?.projectId))

  /* 读回来（走 list，不是直接读盘）—— 「写入后再次读取」这一环 */
  const reread = store.list({ includeSuperseded: true }).find((i) => i.id === pref?.id)
  check('list() 读回来 type 还在', reread?.type === 'preference', String(reread?.type))
  check('list() 读回来 sessionId 还在', reread?.sessionId === 's207-a', String(reread?.sessionId))

  const onlyA = store.list({ sessionId: 's207-a', projectId: '' }).filter((i) => i.scope === 'session')
  const onlyB = store.list({ sessionId: 's207-b', projectId: '' }).filter((i) => i.scope === 'session')
  check('★ 会话私有记忆只在本会话可见（写入链路没把归属弄丢）', onlyA.length === 1 && onlyB.length === 0, `A=${onlyA.length} B=${onlyB.length}`)

  /* ═══════════ ② 整段覆盖写入：内容没变就一个字节都不动 ═══════════ */
  group('207 / ② memory.write()：改一个字再保存，不能把元数据冲掉')

  const beforeIds = rawItems().map((i) => i.id)
  const text = memory.read()
  const result = memory.write(text)
  const after = rawItems()

  check('write 返回成功且条数对得上', result.ok === true && result.count === 3, `ok=${result.ok} count=${result.count}`)

  const activeAfter = after.filter((i) => i.status === 'active')
  check(
    '★ write(read()) 之后 active 还是那 3 条（没有停用+重建出一堆重复）',
    activeAfter.length === 3,
    `active=${activeAfter.length}（改前 ${beforeIds.length} 条）`,
  )
  check(
    '★ 每条的 id 都没变（是「保留」，不是「重建了一模一样的新条目」）',
    activeAfter.every((i) => beforeIds.includes(i.id)),
    activeAfter.map((i) => i.id).join(','),
  )
  check(
    '★ type 没被冲成 fact',
    JSON.stringify(activeAfter.map((i) => i.type).sort()) ===
      JSON.stringify(['fact', 'preference', 'project_rule']),
    activeAfter.map((i) => `${i.type}`).join(','),
  )
  check(
    '★ scope 没被冲成 global',
    JSON.stringify(activeAfter.map((i) => i.scope).sort()) === JSON.stringify(['global', 'project', 'session']),
    activeAfter.map((i) => i.scope).join(','),
  )
  check(
    '★ 会话归属没丢（session 记忆还在 s207-a 名下）',
    activeAfter.some((i) => i.scope === 'session' && i.sessionId === 's207-a'),
    JSON.stringify(activeAfter.map((i) => i.sessionId)),
  )
  check(
    '★ 项目归属没丢（项目记忆不会变成孤儿）',
    activeAfter.some((i) => i.scope === 'project' && i.projectId === 'proj-207'),
    JSON.stringify(activeAfter.map((i) => i.projectId)),
  )
  check(
    '往返是幂等的（updatedAt 都没被顶起来）',
    after.length === beforeIds.length,
    `条目总数 ${beforeIds.length} → ${after.length}`,
  )

  /* ═══════════ ③ 真的删掉一行：该停用的停用，别的仍然不动 ═══════════ */
  group('207 / ③ write() 仍然是一次「覆盖」：删掉的行要停用')

  const keptLine = '自检 207：用户偏好短回答'
  const newLine = '自检 207：这是新加的一行'
  const trimmed = memory
    .read()
    .split('\n')
    .filter((line) => !line.includes('不吃香菜'))
    .join('\n')
  memory.write(`${trimmed}\n${newLine}`)

  const afterTrim = rawItems()
  const sessRow = afterTrim.find((i) => i.content.includes('不吃香菜'))
  check('★ 从文本里删掉的那条被**停用**而不是物理删除（可追溯）', sessRow?.status === 'disabled', String(sessRow?.status))
  const stillPref = afterTrim.find((i) => i.content.includes('短回答'))
  check('没被删的行仍然保留原 type', stillPref?.type === 'preference' && stillPref?.status === 'active', `${stillPref?.type}/${stillPref?.status}`)
  const added = afterTrim.find((i) => i.content.includes('这是新加的一行'))
  check('新出现的一行按老口径落成 fact/global', added?.type === 'fact' && added?.scope === 'global', `${added?.type}/${added?.scope}`)

  /* ═══════════ ④ 边界：空文本 = 全部停用（数据搬运/清空旧整篇走这条路） ═══════════ */
  group('207 / ④ write("") 仍然把记忆清空（停用而非删除）')

  memory.write('')
  const afterEmpty = rawItems()
  check('★ 传空文本后没有任何 active 条目', afterEmpty.filter((i) => i.status === 'active').length === 0, `active=${afterEmpty.filter((i) => i.status === 'active').length}`)
  check('★ 条目一条都没被物理删除（可追溯）', afterEmpty.length > 0, `剩 ${afterEmpty.length} 条历史`)
  check('read() 读回来是空串', memory.read() === '', JSON.stringify(memory.read()))

  /* 恢复三条用于后面 dedupe 那组 */
  memory.clear()
  await remember.run({ content: keptLine, type: 'preference', scope: 'global' }, { sessionId: 's207-a' })

  /* ═══════════ ⑤ 重复内容：不覆盖类型，但要如实说 ═══════════ */
  group('207 / ⑤ dedupe：不静默改类型，也不假装改了')

  const dupResult = await remember.run(
    { content: keptLine, type: 'constraint', scope: 'global' },
    { sessionId: 's207-a' },
  )
  const dupRow = rawItems().find((i) => i.content === keptLine)
  check(
    '★ 重复内容不会把已有那条的类型覆盖掉（scope 语义决定可见性，不能悄悄改）',
    dupRow?.type === 'preference',
    String(dupRow?.type),
  )
  check(
    '★ 但它必须如实说「没改动」，而不是回一句「记下了」',
    /已经在记忆里/.test(dupResult) && /没被这次调用改掉/.test(dupResult),
    dupResult,
  )

  /* 纯字符串老调用方走的是 `memory.append`（`remember` 工具只收对象）——
     这一支要保证「没带 type/scope 时按 fact/global 落库」的老口径不变 */
  group('207 / ⑥ 老调用方：纯字符串 append 仍然按 fact/global 落库')
  const legacy = memory.append('自检 207：老的纯字符串调用')
  const legacyRow = rawItems().find((i) => i.content === '自检 207：老的纯字符串调用')
  check('纯字符串调用仍然按 fact/global 落库', legacyRow?.type === 'fact' && legacyRow?.scope === 'global', `${legacyRow?.type}/${legacyRow?.scope}`)
  check('append 不把 deduped 当失败（首次写入没有这个标记）', legacy.ok === true && !legacy.deduped, `ok=${legacy.ok} deduped=${String(legacy.deduped)}`)

  const legacyDup = memory.append('自检 207：老的纯字符串调用')
  check('重复调用被识别为 deduped，且**往上传**（上层才能如实告知）', legacyDup.deduped === true, String(legacyDup.deduped))

  /* 收尾：不留一条自检数据给后面的组 */
  memory.clear()
}
