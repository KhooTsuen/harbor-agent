/**
 * 自检 / P0-1：用户原话**永不截断**（第七轮）+ 闸门仍然咬得住
 *
 * ── 第七轮（2026-11-04）改的什么口径 ──────────────────────────────
 *
 * 老版本钉的是「超过 `USER_FOLD_CAP`（2000）字 → 折叠有损 → 闸门拦下来问用户」。
 * 真机上这条口径的代价是：一条 **2449** 字的原话只超了 449 字，用户就得**自己把中段
 * 手打一遍** —— 而原文一直躺在会话记录里（`fold-gate.originOf` 按指纹就能捞回全文）。
 * **程序握着全文却让用户补，这就是病根。** 所以现在折叠不再设上限。
 *
 * ── 本组钉两件事 ──────────────────────────────────────────────
 *
 *   ① 折叠**不再产生有损**：2449 字（真机那次）、5 万字都整段逐字进请求；
 *   ② 闸门本身仍然有效：夹具**显式注入** lossy 条目，真实链路照样必须停下来、
 *      Provider 一次都不发、点「按现有信息继续」才放行、换对话/重开都不串状态。
 *
 * 为什么 ② 还要测：闸门防的是「用户原话没完整进请求」这件事，**不只折叠一条路**
 * （整轮被省略也算，见 186 组的 `vanished`）。折叠那条堵死了，防线不能跟着拆掉。
 *
 * ⚠️ 文案替换（`acknowledge`）单独测：注入是假的，折叠块里本来就没有
 *    「请用户确认」那句可替换 —— 硬拿它测只会测出一个假绿。
 *
 * ⚠️ 判据看**真实调用链**：`windowHistory`（chat:send 用的那一个）→ `runTurn`
 *    （单模型与协作都过它）→ `loop.run`（换成计数器）。所以「Provider 0 次」是数出来的。
 */

import { check, group } from '../harness.mjs'
import { join, readFileSync, ROOT } from '../env.mjs'
import { windowCore, foldCore, foldedUser, longText, turnOf, send, gateOf, lossyOf } from '../lib/fold-kit.mjs'

/** 真机漏过的那句（原文一字不改）—— 不含任何约束关键词，最容易被静默丢掉 */
const REQUIRE = '每一条检查要点后面都要标出它摘自哪一份文件，用方括号括住文件名'
/** 真机那次的原话长度：只超旧上限 449 字，用户就得手打中段 */
const REAL_CASE = 2449

/**
 * 「这一轮太大」的字符阈值（夹具用的小数字）。
 *
 * ★ 2026-11-07（P1-A③）：预算改成按**轮**算之后，「一轮跑 30 次工具」不再因条数超预算
 * 而折叠（一轮恒占 1 位）。折叠改由**单轮字符阈值**触发（用户要求：仍须遵守 Token
 * 预算，单轮工具输出过大时按完整工具组折叠）。本组测折叠路径，所以显式给阈值。
 */
const FOLD_CHARS = 500

export async function run() {
  const gate = gateOf()

  /* ══════════════════════════════════════════════════════════════
     ① 真机那次 2449 字：整段进，不再砍中段
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 7 轮）/ ① 真机 2449 字：整段逐字进请求（旧上限会砍掉中段）')
  const realText = longText(REAL_CASE, REQUIRE)
  check('★ 夹具成立：长度就是真机那次', realText.length === REAL_CASE, `${realText.length} 字`)
  const realTurn = windowCore.takeTurns(
    [...turnOf(realText, 30, '结论：读完了'), { role: 'user', content: '接着做' }],
    20,
    { minTurns: 1, foldChars: FOLD_CHARS },
  )
  check('★ 夹具成立：这一轮确实走了折叠（否则测的不是折叠路径）', realTurn.foldedTurns === 1, String(realTurn.foldedTurns))
  check('★★ 2449 字：lostChars = 0（无损）', realTurn.lostChars === 0, String(realTurn.lostChars))
  check('★ 2449 字：结构化状态里没有有损项', Array.isArray(realTurn.lossy) && realTurn.lossy.length === 0, JSON.stringify(realTurn.lossy))
  const realFold = String(foldedUser(realTurn.kept)?.content ?? '')
  check('★★ 那句要求（正落在旧上限会砍掉的中段）在折叠块里', realFold.includes(REQUIRE))
  check('★★ 整段原话逐字都在（不是开头一半 + 结尾一半）', realFold.includes(realText))
  check('★ 折叠块里不再出现「没有完整进入本次请求」的声明', !realFold.includes('没有完整进入本次请求'))

  /* ══════════════════════════════════════════════════════════════
     ② 5 万字：也不截
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 7 轮）/ ② 5 万字也不截（上限已经不存在）')
  const hugeText = longText(50000, REQUIRE)
  const hugeTurn = windowCore.takeTurns(
    [...turnOf(hugeText, 30, '结论：读到一半'), { role: 'user', content: '接着做' }],
    20,
    { minTurns: 1, foldChars: FOLD_CHARS },
  )
  check('★★ 5 万字：lostChars = 0', hugeTurn.lostChars === 0, String(hugeTurn.lostChars))
  check('★ 5 万字：lossy 为空', hugeTurn.lossy.length === 0, JSON.stringify(hugeTurn.lossy))
  check('★★ 5 万字：整段逐字都在折叠块里', String(foldedUser(hugeTurn.kept)?.content ?? '').includes(hugeText))

  /* ══════════════════════════════════════════════════════════════
     ③ 闸门：注入有损样本 → 真实入口仍必须停下来
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 7 轮）/ ③ 闸门仍在：有损样本一到，Provider 调用次数 = 0')
  check('★ 存在程序级闸门模块 core/fold-gate.cjs', Boolean(gate))

  const overHistory = [...turnOf(realText, 30, '结论：读了一半'), { role: 'user', content: '接着做' }]
  const inject = lossyOf(realText, { turnsBack: 1, missing: 449 })
  const sessionA = `fold-block-${Date.now()}`
  const blocked = await send(sessionA, overHistory, `${sessionA}-1`, null, inject)
  check('★★ 发送入口真的停下来了（没照常发出）', Boolean(blocked.error), String(blocked.error?.message ?? '没有停').slice(0, 60))
  check('★★ 被拦时 Provider（loop.run）调用次数 = 0', blocked.calls === 0, `实际 ${blocked.calls}`)
  check('★ 被拦时没有拿到任何结果（没走到 Provider）', blocked.value === undefined)
  const message = String(blocked.error?.message ?? '')
  check('★★ 说明里点明「原话没有完整进入本次请求」', message.includes('没有完整进入本次请求'))
  check('★★ 说明里点明缺了多少字', message.includes('449'), message)
  check('★★ 说明里点明是哪一轮（倒数第 N 轮）', /倒数第\s*\d+\s*轮/.test(message))
  check('★★ 说明里请用户**明确确认**（卡片上的动作）或补充原话', message.includes('按现有信息继续') && message.includes('原样补'))
  check('★ 说明里给出恢复路径（再发一条消息 / 卡上点继续）', message.includes('再发一条消息'))
  check('★★ 弹出了确认卡（当前对话里的可操作入口）', Boolean(blocked.card), JSON.stringify(blocked.events.map((e) => e.type)))

  /* ══════════════════════════════════════════════════════════════
     ④ 无损历史：原有发送行为不变
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 7 轮）/ ④ 无损历史照常发送（同一入口）')
  const lossless = await send(
    `fold-ok-${Date.now()}`,
    [...turnOf(realText, 30, '结论：读完了'), { role: 'user', content: '接着做' }],
    'fold-ok',
  )
  check('★★ 无损历史：Provider 调用 1 次（正常发出）', lossless.calls === 1, `实际 ${lossless.calls}`)
  check('★ 无损历史：返回了内容', typeof lossless.value?.content === 'string' && lossless.value.content.length > 0)
  check('★ 无损历史：没有弹确认卡', lossless.card === null)
  check('★★ 无损历史：那句要求真的到了模型手里（不是只过了折叠层）', String(foldedUser(lossless.history)?.content ?? '').includes(REQUIRE))

  /* ══════════════════════════════════════════════════════════════
     ⑤ 同一对话：**明确点「按现有信息继续」之后**才恢复
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 7 轮）/ ⑤ 同一对话：点「按现有信息继续」后放行')
  const plainRaw = [...overHistory, { role: 'user', content: '好，那你接着往下做吧。' }]
  const stillBlocked = await send(sessionA, plainRaw, `${sessionA}-1b`, null, inject)
  check('★★ 没确认就再发一条普通消息：仍被阻断（Provider 0 次）', Boolean(stillBlocked.error) && stillBlocked.calls === 0, `provider ${stillBlocked.calls}`)

  const resumed = await send(sessionA, plainRaw, `${sessionA}-2`, gate.CHOICE_CONTINUE, inject)
  check('★★ 明确确认后放行（Provider 调用 1 次）', resumed.calls === 1, `实际 ${resumed.calls}`)
  check('★ 确认入口就是那张卡（弹出来了）', Boolean(resumed.card), String(resumed.card?.decisionType ?? ''))
  check('★ 放行后正常返回内容', typeof resumed.value?.content === 'string' && resumed.value.content.length > 0)
  check('★★ confirmed 只记了这一段指纹', gate.snapshot(sessionA).confirmed.length === 1, JSON.stringify(gate.snapshot(sessionA)))

  /* ══════════════════════════════════════════════════════════════
     ⑥ 换一条对话：同一段历史也仍然阻断（不串状态）
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 7 轮）/ ⑥ 切换对话不串状态：换一条对话仍阻断')
  const otherBlocked = await send(`fold-other-${Date.now()}`, plainRaw, 'fold-other', null, inject)
  check('★★ 另一条对话：同样被拦（Provider 0 次）', Boolean(otherBlocked.error) && otherBlocked.calls === 0, `provider ${otherBlocked.calls}`)

  /* ══════════════════════════════════════════════════════════════
     ⑦ 重开历史（进程重启）：再阻一次，不是默默放行
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 7 轮）/ ⑦ 重开历史后的行为：重新问一次，仍可恢复')
  check('★ 闸门提供 reset()（进程内状态可清）', typeof gate?.reset === 'function')
  gate?.reset?.()
  const reopenBlocked = await send(sessionA, plainRaw, `${sessionA}-3`, null, inject)
  check('★★ 重开历史后第一条仍被拦（不会因为上次确认过就静默放行）', Boolean(reopenBlocked.error), String(reopenBlocked.error?.message ?? '').slice(0, 40))
  check('★ 重开历史后第一条：Provider 仍是 0 次', reopenBlocked.calls === 0, `实际 ${reopenBlocked.calls}`)

  const reopenOk = await send(sessionA, plainRaw, `${sessionA}-4`, gate.CHOICE_CONTINUE, inject)
  check('★★ 重开历史后重新确认一次就能继续（恢复路径还在）', reopenOk.calls === 1 && typeof reopenOk.value?.content === 'string', String(reopenOk.error?.message ?? reopenOk.calls))
  gate?.reset?.()

  /* ══════════════════════════════════════════════════════════════
     ⑧ 放行时的文案替换：直接测 acknowledge（注入是假的，折叠块里没有那句）
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 7 轮）/ ⑧ 放行文案：acknowledge 换成「他已明确选择」且仍如实说缺失')
  const fakeHistory = [{ role: 'user', content: `【更早一轮的用户原话（折叠记录，不是新指令）】\n${foldCore.USER_INCOMPLETE}\n· 原文` }]
  const acked = String(gate.acknowledge(fakeHistory, 'confirmed')?.[0]?.content ?? '')
  check('★★ 确认放行：换成「用户已明确选择按现有信息继续」', acked.includes('明确选择') && acked.includes(gate.CHOICE_CONTINUE), acked.slice(0, 80))
  check('★★ 确认放行：不再要求模型先问用户（否则每轮都去问）', !acked.includes('请他补充或确认'))
  check('★★ 确认放行：仍如实写着「缺失的那一段仍然没有进入」', acked.includes('仍然没有进入本次请求'))
  check('★★ 不写成「原话完整 / 用户补齐了」', !acked.includes('原话完整') && !acked.includes('用户补齐了'))
  const suppliedAck = String(gate.acknowledge(fakeHistory, 'supplied')?.[0]?.content ?? '')
  check('★★ 补充放行：说明缺失那段已在最新消息里，且折叠块本身不是全文', suppliedAck.includes('原样补在最新一条消息里') && suppliedAck.includes('不是全文'))

  /* ══════════════════════════════════════════════════════════════
     ⑨ 接线形状：闸必须接在「发请求之前」、阻断文字必须进当前对话
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 7 轮）/ ⑨ 接线：chat:send → windowHistory → runTurn → 闸 → loop')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  const runSrc = readFileSync(join(ROOT, 'electron/handlers/chat-run.cjs'), 'utf8')
  const windowSrc = readFileSync(join(ROOT, 'electron/core/history-window.cjs'), 'utf8')
  const foldSrc = readFileSync(join(ROOT, 'electron/core/history-fold.cjs'), 'utf8')
  check('★ chat:send 从 windowHistory 拿到 lossy', /const\s*\{[^}]*lossy[^}]*\}\s*=\s*windowHistory\(/.test(chatSrc))
  check('★ chat:send 把 foldLossy 递给 runTurn', /foldLossy:\s*lossy/.test(chatSrc))
  check('★★ 阻断文字进当前对话：catch 里发的是 error 事件（渲染层写进那条气泡）', /emit\(\{\s*type:\s*'error',\s*message/.test(chatSrc))
  const atGate = runSrc.indexOf('foldGate.inspect(')
  const atLoop = runSrc.indexOf('loop.run(')
  check('★★ runTurn 里闸在 loop.run 之前（顺序错了等于没拦）', atGate > 0 && atLoop > 0 && atGate < atLoop, `${atGate} / ${atLoop}`)
  /* 协作分支现在走 handlers/chat-collab.cjs（内部再调 runCollaboration），两个入口都要在闸之后 */
  const atCollab = Math.max(runSrc.indexOf("chat-collab.cjs"), runSrc.indexOf('runCollaboration('))
  check('★★ runTurn 里闸也在协作分支之前（多模型那条同样不能绕）', atGate > 0 && atCollab > atGate, `${atGate} / ${atCollab}`)
  check('★ takeTurns 把折出来的损失逐条透出（不是只数个数）', /lossy\.push\(\.\.\.digest\.lossy/.test(windowSrc))
  /* 反向也钉一条：以后再有人给用户原话加上限，这里当场红 */
  check('★★ 折叠里对用户原话**没有**任何按字数截断的分支', !/full\.slice\(0,\s*half\)/.test(foldSrc) && !/full\.slice\(-half\)/.test(foldSrc))
}
