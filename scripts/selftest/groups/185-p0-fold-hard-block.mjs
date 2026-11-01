/**
 * 自检 / P0-1：原话被折叠截断时**程序级阻断**（不是提示词求模型自觉）
 *
 * ── 这一组钉什么 ──────────────────────────────────────────────
 *
 *   ① 边界：**正好** `USER_FOLD_CAP`（2000）字 → 无损（lostChars = 0、lossy 为空）
 *   ② 超过上限、约束放在**会被截掉的中段** → lossy 报出缺字；夹具先自证「约束确实不在折叠文本里」
 *   ③ **真实发送入口**（`chat-run.runTurn`）→ 停下来，且 `loop.run`（Provider 那一段）**一次没被调用**
 *   ④ 无损历史 → 同一个入口正常放行（`loop.run` 调用 1 次）
 *   ⑤ 没确认就再发一条普通消息 → **仍阻断**；点了卡上的「按现有信息继续」才放行，
 *      而且折叠块里换成「用户明确选择继续」这句（不会永久挡住，也不假装他补齐了）
 *   ⑥ 换一条对话（同一段历史、不同 sessionId）→ **仍然阻断**（状态不串）
 *   ⑦ 重开历史（进程重启 = `reset()`）→ 再拦一次、再问一次，不是默默放行
 *   ⑧ 接线形状：闸必须在 `loop.run` 之前、阻断文字必须进当前对话
 *
 * ⚠️ 判据看的是**真实调用链**：`windowHistory`（chat:send 用的那一个）→ `runTurn`
 *    （单模型与协作都过它）→ `loop.run`。最后那一段被换成计数器，
 *    所以「Provider 调用次数为 0」是数出来的，不是推的。
 *    造数 / 打桩 / 点卡都在 `lib/fold-kit.mjs`（186 组用的是同一份）。
 */

import { check, group } from '../harness.mjs'
import { join, readFileSync, ROOT } from '../env.mjs'
import { windowCore, foldCore, foldedUser, longText, turnOf, send, gateOf } from '../lib/fold-kit.mjs'

/** 真机漏过的那句（原文一字不改）—— 不含任何约束关键词，最容易被静默丢掉 */
const REQUIRE = '每一条检查要点后面都要标出它摘自哪一份文件，用方括号括住文件名'

export async function run() {
  const gate = gateOf()

  /* ══════════════════════════════════════════════════════════════
     ① 边界：正好 2000 字（无损）
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 5 轮）/ ① 正好 USER_FOLD_CAP：无损，不算有损')
  const capText = longText(foldCore.USER_FOLD_CAP, REQUIRE)
  check('★ 夹具成立：长度正好是上限', capText.length === foldCore.USER_FOLD_CAP, `${capText.length} 字`)
  const capTurn = windowCore.takeTurns(
    [...turnOf(capText, 30, '结论：读完了'), { role: 'user', content: '接着做' }],
    20,
    { minTurns: 1 },
  )
  check('★ 正好 2000 字：lostChars = 0（无损）', capTurn.lostChars === 0, String(capTurn.lostChars))
  check('★★ 正好 2000 字：结构化状态里**没有**有损项', Array.isArray(capTurn.lossy) && capTurn.lossy.length === 0, JSON.stringify(capTurn.lossy))
  check('★ 正好 2000 字：原话整段进了折叠块', String(foldedUser(capTurn.kept)?.content ?? '').includes(capText))

  /* ══════════════════════════════════════════════════════════════
     ② 超过上限 + 约束在中段（会被截掉）
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 5 轮）/ ② 超上限、关键约束落在会被截掉的中段')
  const overText = longText(foldCore.USER_FOLD_CAP + 600, REQUIRE)
  const at = overText.indexOf(REQUIRE)
  check(
    '★ 夹具成立：约束落在「开头一半 / 结尾一半」之外（必被截掉的位置）',
    at > foldCore.USER_FOLD_CAP / 2 && at < overText.length - foldCore.USER_FOLD_CAP / 2,
    `位置 ${at} / 全长 ${overText.length}`,
  )
  const overHistory = [...turnOf(overText, 30, '结论：读了一半'), { role: 'user', content: '接着做' }]
  const overTurn = windowCore.takeTurns(overHistory, 20, { minTurns: 1 })
  const overFolded = String(foldedUser(overTurn.kept)?.content ?? '')
  check('★★ 夹具成立：那句约束**确实不在**折叠文本里（这就是要拦的漏）', !overFolded.includes(REQUIRE))
  check('★ 超上限：lostChars > 0', overTurn.lostChars > 0, String(overTurn.lostChars))
  check(
    '★★ 超上限：结构化状态里带着「哪一轮、缺多少字」',
    Array.isArray(overTurn.lossy) &&
      overTurn.lossy.length === 1 &&
      overTurn.lossy[0].missing === overTurn.lostChars &&
      overTurn.lossy[0].total === overText.length &&
      typeof overTurn.lossy[0].fp === 'string' &&
      overTurn.lossy[0].fp.length >= 8,
    JSON.stringify(overTurn.lossy),
  )

  /* ══════════════════════════════════════════════════════════════
     ③ 真实发送入口：调到 Provider 之前就停手
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 5 轮）/ ③ 真实发送入口被拦下：Provider 调用次数 = 0')
  check('★ 存在程序级闸门模块 core/fold-gate.cjs', Boolean(gate))

  const sessionA = `fold-block-${Date.now()}`
  const blocked = await send(sessionA, overHistory, `${sessionA}-1`)
  check('★★ 发送入口真的停下来了（没照常发出）', Boolean(blocked.error), String(blocked.error?.message ?? '没有停').slice(0, 60))
  check('★★ 被拦时 Provider（loop.run）调用次数 = 0', blocked.calls === 0, `实际 ${blocked.calls}`)
  check('★ 被拦时没有拿到任何结果（没走到 Provider）', blocked.value === undefined)
  const message = String(blocked.error?.message ?? '')
  check('★★ 说明里点明「原话没有完整进入本次请求」', message.includes('没有完整进入本次请求'))
  check('★★ 说明里点明缺了多少字（与 lostChars 一致）', message.includes(String(overTurn.lostChars)))
  check('★★ 说明里点明是哪一轮（倒数第 N 轮）', /倒数第\s*\d+\s*轮/.test(message))
  check('★★ 说明里请用户**明确确认**（卡片上的动作）或补充原话', message.includes('按现有信息继续') && message.includes('原样补'))
  check('★ 说明里给出恢复路径（再发一条消息 / 卡上点继续）', message.includes('再发一条消息'))

  /* ══════════════════════════════════════════════════════════════
     ④ 无损历史：原有发送行为不变
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 5 轮）/ ④ 无损历史照常发送（同一入口）')
  const lossless = await send(
    `fold-ok-${Date.now()}`,
    [...turnOf(capText, 30, '结论：读完了'), { role: 'user', content: '接着做' }],
    'fold-ok',
  )
  check('★★ 无损历史：Provider 调用 1 次（正常发出）', lossless.calls === 1, `实际 ${lossless.calls}`)
  check('★ 无损历史：返回了内容', typeof lossless.value?.content === 'string' && lossless.value.content.length > 0)
  check('★ 无损历史：没有弹确认卡', lossless.card === null)
  check('★ 无损历史：折叠块里没有「没有完整进入本次请求」那句', !String(foldedUser(lossless.history)?.content ?? '').includes('没有完整进入本次请求'))

  /* ══════════════════════════════════════════════════════════════
     ⑤ 同一对话：**明确点「按现有信息继续」之后**才恢复
        （第六轮改口径：「提示过一次」不再等于「用户同意」——见 186 组）
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 5 轮）/ ⑤ 同一对话：点「按现有信息继续」后放行，并如实说明他没补齐')
  const plainRaw = [...overHistory, { role: 'user', content: '好，那你接着往下做吧。' }]
  const stillBlocked = await send(sessionA, plainRaw, `${sessionA}-1b`)
  check('★★ 没确认就再发一条普通消息：仍被阻断（Provider 0 次）', Boolean(stillBlocked.error) && stillBlocked.calls === 0, `provider ${stillBlocked.calls}`)

  const resumed = await send(sessionA, plainRaw, `${sessionA}-2`, gate.CHOICE_CONTINUE)
  check('★★ 明确确认后放行（Provider 调用 1 次）', resumed.calls === 1, `实际 ${resumed.calls}`)
  check('★ 确认入口就是那张卡（弹出来了）', Boolean(resumed.card), String(resumed.card?.decisionType ?? ''))
  check('★ 放行后正常返回内容', typeof resumed.value?.content === 'string' && resumed.value.content.length > 0)
  const ackFold = String(foldedUser(resumed.history)?.content ?? '')
  check('★★ 折叠块说清「用户明确选择继续」（不是仍在要求模型先问）', ackFold.includes('明确选择'), ackFold.slice(0, 80))
  check('★ 折叠块里不再留「请他补充或确认」那句（否则模型每轮都去问）', !ackFold.includes('请他补充或确认'))
  check('★★ 放行后仍如实保留「中间 N 字没有进入本次请求」这行（不假装原文都在）', ackFold.includes(`${overTurn.lostChars} 字没有进入本次请求`))
  check('★★ 不写成「原话完整 / 用户补齐了」', !ackFold.includes('原话完整') && !ackFold.includes('用户补齐了'))

  /* ══════════════════════════════════════════════════════════════
     ⑥ 换一条对话：同一段历史也仍然阻断（不串状态）
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 5 轮）/ ⑥ 切换对话不串状态：换一条对话仍阻断')
  const otherBlocked = await send(`fold-other-${Date.now()}`, plainRaw, 'fold-other')
  check('★★ 另一条对话：同样被拦（Provider 0 次）', Boolean(otherBlocked.error) && otherBlocked.calls === 0, `provider ${otherBlocked.calls}`)

  /* ══════════════════════════════════════════════════════════════
     ⑦ 重开历史（进程重启）：再阻一次，不是默默放行
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 5 轮）/ ⑦ 重开历史后的行为：重新问一次，仍可恢复')
  check('★ 闸门提供 reset()（进程内状态可清）', typeof gate?.reset === 'function')
  gate?.reset?.()
  const reopenBlocked = await send(sessionA, plainRaw, `${sessionA}-3`)
  check('★★ 重开历史后第一条仍被拦（不会因为上次确认过就静默放行）', Boolean(reopenBlocked.error), String(reopenBlocked.error?.message ?? '').slice(0, 40))
  check('★ 重开历史后第一条：Provider 仍是 0 次', reopenBlocked.calls === 0, `实际 ${reopenBlocked.calls}`)

  const reopenOk = await send(sessionA, plainRaw, `${sessionA}-4`, gate.CHOICE_CONTINUE)
  check('★★ 重开历史后重新确认一次就能继续（恢复路径还在）', reopenOk.calls === 1 && typeof reopenOk.value?.content === 'string', String(reopenOk.error?.message ?? reopenOk.calls))
  gate?.reset?.()

  /* ══════════════════════════════════════════════════════════════
     ⑧ 接线形状：闸必须接在「发请求之前」、阻断文字必须进当前对话
        （行为在上面钉过；这几条防的是「以后改接线时静默断开」）
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 5 轮）/ ⑧ 接线：chat:send → windowHistory → runTurn → 闸 → loop')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  const runSrc = readFileSync(join(ROOT, 'electron/handlers/chat-run.cjs'), 'utf8')
  const windowSrc = readFileSync(join(ROOT, 'electron/core/history-window.cjs'), 'utf8')
  check('★ chat:send 从 windowHistory 拿到 lossy', /const\s*\{[^}]*lossy[^}]*\}\s*=\s*windowHistory\(/.test(chatSrc))
  check('★ chat:send 把 foldLossy 递给 runTurn', /foldLossy:\s*lossy/.test(chatSrc))
  check('★★ 阻断文字进当前对话：catch 里发的是 error 事件（渲染层写进那条气泡）', /emit\(\{\s*type:\s*'error',\s*message/.test(chatSrc))
  const atGate = runSrc.indexOf('foldGate.inspect(')
  const atLoop = runSrc.indexOf('loop.run(')
  check('★★ runTurn 里闸在 loop.run 之前（顺序错了等于没拦）', atGate > 0 && atLoop > 0 && atGate < atLoop, `${atGate} / ${atLoop}`)
  check('★★ runTurn 里闸也在协作分支之前（多模型那条同样不能绕）', atGate < runSrc.indexOf('runCollaboration('), `${atGate}`)
  check('★ takeTurns 把折出来的损失逐条透出（不是只数个数）', /lossy\.push\(\.\.\.digest\.lossy/.test(windowSrc))
}
