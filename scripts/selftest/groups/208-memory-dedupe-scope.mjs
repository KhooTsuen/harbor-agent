/**
 * 自检 / 208 —— 记忆的去重键必须含 scope 与归属（P1，2026-11-05）
 *
 * ── 起因（探针实测） ────────────────────────────────────────────
 *
 * `store.add` 以前只比内容：`item.content.trim() === content` 就算重复。
 * 于是三条实测行为全都是错的：
 *
 *   · `remember(scope=session)` 一条已经是 global 的内容 → 回 `deduped`，
 *     库里仍是那条 global —— 用户明确要求的「只在这个会话里生效」**建不起来**，
 *     内容照样全局可见（受限意图被降级成公开，SEC-065 那个方向）；
 *   · 设置页新增时选「项目」→ 只弹「这条已经记过了」；
 *   · `docs/Memory设计.md` §3 说的是「不同 scope 的合法差异不是冲突
 *     （User 用 pnpm、Project A 用 npm）」，所以这种共存是**设计允许**的。
 *
 * ── 这一组钉什么 ───────────────────────────────────────────────
 *
 * ① 同内容 × 不同 scope/归属 = 三条独立记忆（不是重复），各自的 type 都留住；
 * ② 可见性各归各的：别的会话 / 项目看不见受限那两条；
 * ③ 同内容 + 同 scope + 同归属才算重复，且重复时**不覆盖**已有类型；
 * ④ 历史库里已经存在的同内容多条：能独立改、独立删、都查得到。
 *
 * `type` 刻意**不进**去重键：同内容同 scope 换类型是同一句话贴两个标签，
 * 不是两件事（该行为由 207 ⑤ 钉住）。
 */

import { check, group } from '../harness.mjs'
import { join, ROOT, require as req, readFileSync, writeFileSync, memory } from '../env.mjs'

const store = req(join(ROOT, 'electron/core/memory-store.cjs'))

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
  /* ═══════════ ① 同内容 × 不同 scope/归属：三条独立记忆 ═══════════ */
  group('208 / ① 同内容可以分别存在于 global / project / session（去重键含 scope 与归属）')

  const sharedLine = '自检 208：提交前先跑测试'
  memory.clear()
  const g208 = memory.add({ content: sharedLine, type: 'fact', scope: 'global' })
  const p208 = memory.add({
    content: sharedLine,
    type: 'project_rule',
    scope: 'project',
    projectId: 'proj-208',
  })
  const s208 = memory.add({
    content: sharedLine,
    type: 'constraint',
    scope: 'session',
    sessionId: 's208',
  })

  check(
    '★ 三条都是新增（没被当成重复吃掉）',
    !g208.deduped && !p208.deduped && !s208.deduped,
    `g=${String(g208.deduped)} p=${String(p208.deduped)} s=${String(s208.deduped)}`,
  )
  check(
    '★ 库里真的有三条同内容条目',
    rawItems().filter((i) => i.content === sharedLine).length === 3,
    String(rawItems().filter((i) => i.content === sharedLine).length),
  )
  const scopes = [g208.item?.scope, p208.item?.scope, s208.item?.scope].join(',')
  check('★ 三条 scope 各自保留', scopes === 'global,project,session', scopes)
  const types = [g208.item?.type, p208.item?.type, s208.item?.type].join(',')
  check(
    '★ 三条 type 各自保留（同内容不同标签不互相顶掉）',
    types === 'fact,project_rule,constraint',
    types,
  )

  const pRow = rawItems().find((i) => i.id === p208.item?.id)
  const sRow = rawItems().find((i) => i.id === s208.item?.id)
  check('项目那条带 projectId', pRow?.projectId === 'proj-208', String(pRow?.projectId))
  check('会话那条带 sessionId', sRow?.sessionId === 's208', String(sRow?.sessionId))

  /* ═══════════ ② 可见性：受限的那两条只在自己上下文可见 ═══════════ */
  group('208 / ② 同内容三条各归各的：别的会话/项目看不见受限那两条')

  const inHere = store.list({ sessionId: 's208', projectId: 'proj-208' }).map((i) => i.scope)
  const inOther = store.list({ sessionId: 's208-zzz', projectId: 'proj-zzz' }).map((i) => i.scope)
  check('★ 本会话 + 本项目看得见三条', inHere.length === 3, inHere.join(','))
  check('★ 别的会话/项目只看得见那条 global', inOther.join(',') === 'global', inOther.join(','))

  /* ═══════════ ③ 同 scope 同归属再写一次才算重复 ═══════════ */
  group('208 / ③ 同内容 + 同 scope + 同归属 → 才算重复，且不覆盖已有类型')

  const again = memory.add({
    content: sharedLine,
    type: 'instruction',
    scope: 'session',
    sessionId: 's208',
  })
  check('重复被认出来', again.deduped === true, String(again.deduped))
  const sRowAfter = rawItems().find((i) => i.id === s208.item?.id)
  check(
    '★ 重复时没覆盖已有那条的 type（仍是 constraint）',
    sRowAfter?.type === 'constraint',
    String(sRowAfter?.type),
  )
  check(
    '★ 也没多出一条影子条目',
    rawItems().filter((i) => i.content === sharedLine).length === 3,
    String(rawItems().filter((i) => i.content === sharedLine).length),
  )

  /* ═══════════ ④ 历史重复记录：独立改 / 独立删 / 都查得到 ═══════════ */
  group('208 / ④ 库里已有同内容两条（历史数据）：各自能独立改、删、查')

  memory.clear()
  const hist = memory.add({ content: '自检 208：用 pnpm', type: 'fact', scope: 'global' })
  {
    /* 老版本只按内容去重，历史库里确实可能已经有这种同内容多归属的条目 —— 手工造一条 */
    const file = store.filePath()
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const base = data.items[0]
    data.items.push({
      ...base,
      id: 'mem_208_proj',
      seq: (base.seq ?? 0) + 1,
      type: 'preference',
      scope: 'project',
      projectId: 'proj-208d',
    })
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  }

  store.update(hist.item.id, { content: '自检 208：用 pnpm 而不是 npm' })
  const projRow = rawItems().find((i) => i.id === 'mem_208_proj')
  check(
    '★ 改全局那条不会改到项目那条（各自独立）',
    projRow?.content === '自检 208：用 pnpm',
    String(projRow?.content),
  )
  check('★ 项目那条的 scope 没被串用', projRow?.scope === 'project', String(projRow?.scope))
  check('★ 项目那条的 type 也没被串用', projRow?.type === 'preference', String(projRow?.type))

  /* 管理视图（不传 projectId/sessionId）= 设置页搜索；带空上下文会把项目那条挡在外面 */
  const found = store.search('pnpm')
  check(
    '★ 检索两条都能命中（不会互相遮住）',
    found.filter((i) => i.content.includes('用 pnpm')).length === 2,
    String(found.filter((i) => i.content.includes('用 pnpm')).length),
  )

  memory.remove('mem_208_proj')
  const afterRemove = rawItems()
  check(
    '★ 删项目那条不动全局那条',
    afterRemove.length === 1 && afterRemove[0].id === hist.item.id,
    afterRemove.map((i) => i.id).join(','),
  )

  /* 收尾：不留一条自检数据给后面的组 */
  memory.clear()
}
