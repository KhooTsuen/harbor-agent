/**
 * 自检 / P0-1 第六轮：有损被阻断之后**怎么恢复**（提示 ≠ 确认）
 *
 * ── 这一组钉的是用户点名的缺陷 ────────────────────────────────
 *
 * 上一版在首次阻断时记一笔「提示过」，于是同一对话的**下一条消息不论内容**都放行，
 * 还把折叠块写成「用户已看到并选择继续」。提示过不等于用户确认过 —— 这里要钉住：
 *   ① 第一次有损发送：阻断、Provider 0 次、**弹确认卡**（缺哪轮 / 缺多少 / 两个出口）
 *   ② 没确认的第二条普通消息：仍阻断（不能因为「提示过一次」就放行）
 *   ③ 第二条里写着「确认 / 继续 / 好的」也不算 —— 不认关键词，只认卡片动作
 *   ④ 点了「按现有信息继续」：只对**当前对话 + 当前指纹**放行，Provider 1 次
 *   ⑤ 换一段有损原话：重新阻断
 *   ⑥ 换一条对话：仍是阻断（状态不串）
 *   ⑦ 进程重启（reset）：不凭旧状态放行，得重新确认
 *   ⑧ 无损历史：正常发送（0 张卡）
 *   ⑨ 补充到位（把缺失那段**原样**贴回下一条消息）：自动放行；只贴一部分仍阻断
 *   ⑩ 放行后历史仍**如实标明缺失**，不写成「原话完整 / 用户补齐了」
 *
 * 判据走真实链路：`windowHistory` → `chat-run.runTurn` → `loop.run`（计数器），
 * 卡片走真实往返 `chat-confirm.askClarify` → `confirm-bridge`（测试按 confirmId 回话）。
 * 造数 / 打桩 / 点卡在 `lib/fold-kit.mjs`（185 组用的是同一份）。
 */

import { check, group } from '../harness.mjs'
import { readFileSync, join, ROOT } from '../env.mjs'
import { windowCore, foldCore, foldedUser, longText, turnOf, send, gateOf } from '../lib/fold-kit.mjs'

const REQUIRE = '每一条检查要点后面都要标出它摘自哪一份文件，用方括号括住文件名'

export async function run() {
  const gate = gateOf()
  const overText = longText(foldCore.USER_FOLD_CAP + 600, REQUIRE)
  const overHistory = [...turnOf(overText, 30, '结论：读了一半'), { role: 'user', content: '接着做' }]
  const sessionA = `g6-a-${Date.now()}`

  group('P0-1（第 6 轮）/ ① 首次有损发送：阻断 + 弹确认卡 + Provider 0 次')
  const first = await send(sessionA, overHistory, `${sessionA}-1`)
  check('★★ 被拦（不是照常发出）', Boolean(first.error), String(first.error?.message ?? '没有停下').slice(0, 60))
  check('★★ Provider（loop.run）调用 0 次', first.calls === 0, `实际 ${first.calls}`)
  check('★★ 弹出了确认卡（当前对话里的可操作入口）', Boolean(first.card), JSON.stringify(first.events.map((e) => e.type)))
  check('★ 卡片走澄清那条往返（decisionType = clarify）', first.card?.decisionType === 'clarify', String(first.card?.decisionType))
  const question = String(first.card?.questions?.[0]?.question ?? '')
  check('★★ 卡上说清「这轮没发出去」+ 缺多少字', question.includes('没有发给模型') && /缺\s*\d+\s*字/.test(question), question)
  check('★ 卡上说清是较早哪一轮（倒数第 N 轮）', /倒数第\s*\d+\s*轮/.test(question), question)
  const labels = (first.card?.questions?.[0]?.options ?? []).map((one) => one.label)
  check('★★ 两个出口都在：明确继续 / 我先补充', labels.includes(gate.CHOICE_CONTINUE) && labels.includes(gate.CHOICE_SUPPLEMENT), labels.join(' / '))
  check('★★ 默认选项是「我先补充」（离场不会替他选「继续」）', first.card?.questions?.[0]?.defaultValue === gate.CHOICE_SUPPLEMENT)
  check('★★ 阻断说明进当前对话：含「哪一轮 / 缺多少 / 两条恢复路径」', ['倒数第', '缺', '按现有信息继续', '原样补'].every((word) => String(first.error?.message ?? '').includes(word)))

  group('P0-1（第 6 轮）/ ② 「已提示」≠「已获确认」：第二条普通消息仍阻断')
  const plain = [...overHistory, { role: 'user', content: '好，那你接着往下做吧。' }]
  const second = await send(sessionA, plain, `${sessionA}-2`)
  check('★★ 没确认：第二条普通消息仍被拦（Provider 0 次）', Boolean(second.error) && second.calls === 0, `provider ${second.calls}`)
  check('★★ 说明里点明这是重复提醒（不是我替他当成同意）', String(second.error?.message ?? '').includes('第 2 次提醒'), String(second.error?.message ?? '').slice(-60))
  const snap2 = gate.snapshot(sessionA)
  check('★★ 状态是两份：已提示 > 0，已获确认 = 0', snap2.notified.length > 0 && snap2.confirmed.length === 0, JSON.stringify(snap2))

  group('P0-1（第 6 轮）/ ③ 不认关键词：第二条里写「确认 / 继续」也不算')
  const keyword = [...overHistory, { role: 'user', content: '确认，继续，好的，没问题，按你说的做。' }]
  const third = await send(sessionA, keyword, `${sessionA}-3`)
  check('★★ 关键词不构成确认（仍阻断，Provider 0 次）', Boolean(third.error) && third.calls === 0, `provider ${third.calls}`)

  group('P0-1（第 6 轮）/ ④ 点了「按现有信息继续」：当前对话 + 当前指纹放行')
  const resumed = await send(sessionA, plain, `${sessionA}-4`, gate.CHOICE_CONTINUE)
  check('★★ 明确确认后放行：Provider 调用 1 次', resumed.calls === 1, `实际 ${resumed.calls}`)
  check('★ 放行后拿到正常结果', typeof resumed.value?.content === 'string' && resumed.value.content.length > 0)
  const ackFold = String(foldedUser(resumed.history)?.content ?? '')
  check('★★ 折叠块改成「用户已明确选择按现有信息继续」', ackFold.includes('明确选择') && ackFold.includes(gate.CHOICE_CONTINUE))
  check('★★ 但仍如实写着缺失（不许写成原文都在）', ackFold.includes('没有进入本次请求'), ackFold.slice(0, 60))
  check('★★ 没有出现「原话完整 / 用户补齐了」这类假话', !ackFold.includes('原话完整') && !ackFold.includes('用户补齐了'))
  check('★★ 不许再说「先向用户确认」（否则模型每轮都去问）', !ackFold.includes('请他补充或确认'))
  check('★★ confirmed 只记了这一段指纹', gate.snapshot(sessionA).confirmed.length === 1, JSON.stringify(gate.snapshot(sessionA)))

  group('P0-1（第 6 轮）/ ⑤ 换一段有损原话：重新阻断')
  const otherText = longText(foldCore.USER_FOLD_CAP + 900, '这一段的要求是：改完之后把 diff 贴给我看')
  const otherHistory = [...turnOf(otherText, 30, '结论：改了'), { role: 'user', content: '继续' }]
  const otherTurn = windowCore.takeTurns(otherHistory, 20, { minTurns: 1 })
  check('★ 夹具成立：这一段确实有损（换了原话才谈得上「重新阻断」）', otherTurn.lostChars > 0, String(otherTurn.lostChars))
  const another = await send(sessionA, otherHistory, `${sessionA}-5`)
  check('★★ 同一对话、换了有损原话：仍阻断（Provider 0 次）', Boolean(another.error) && another.calls === 0, `provider ${another.calls}`)
  check('★ 新的一段有它自己的指纹（没有跟着被确认）', gate.snapshot(sessionA).confirmed.length === 1)

  group('P0-1（第 6 轮）/ ⑥ 换一条对话：同一段历史仍阻断（状态不串）')
  const otherSession = `g6-b-${Date.now()}`
  const crossed = await send(otherSession, overHistory, `${otherSession}-1`)
  check('★★ 另一条对话：同样被拦（Provider 0 次）', Boolean(crossed.error) && crossed.calls === 0, `provider ${crossed.calls}`)

  group('P0-1（第 6 轮）/ ⑦ 进程重启：不凭旧状态放行')
  gate.reset()
  const afterRestart = await send(sessionA, plain, `${sessionA}-6`)
  check('★★ reset（重开应用）后：同一段历史重新阻断', Boolean(afterRestart.error) && afterRestart.calls === 0, `provider ${afterRestart.calls}`)
  check('★ 重启后没有残留的 confirmed', gate.snapshot(sessionA).confirmed.length === 0)
  const reconfirm = await send(sessionA, plain, `${sessionA}-7`, gate.CHOICE_CONTINUE)
  check('★★ 重新确认后仍能继续（恢复路径还在）', reconfirm.calls === 1 && typeof reconfirm.value?.content === 'string')

  group('P0-1（第 6 轮）/ ⑧ 无损历史：照常发送（0 张卡）')
  const capText = longText(foldCore.USER_FOLD_CAP, REQUIRE)
  const ok = await send(
    `g6-ok-${Date.now()}`,
    [...turnOf(capText, 8, '结论：读完了'), { role: 'user', content: '接着做' }],
    'g6-ok',
  )
  check('★★ 无损：Provider 调用 1 次', ok.calls === 1, `实际 ${ok.calls}`)
  check('★ 无损：没有弹确认卡', ok.card === null)

  group('P0-1（第 6 轮）/ ⑨ 补充到位：整段原样贴回 → 自动放行；只贴一部分仍阻断')
  const fillSession = `g6-c-${Date.now()}`
  const partial = [...overHistory, { role: 'user', content: `缺的那半句我记得是：${REQUIRE.slice(0, 12)}` }]
  const partSend = await send(fillSession, partial, `${fillSession}-1`)
  check('★★ 只补了一部分：仍阻断（Provider 0 次）', Boolean(partSend.error) && partSend.calls === 0, `provider ${partSend.calls}`)
  const full = [...overHistory, { role: 'user', content: overText }]
  const fullSend = await send(fillSession, full, `${fillSession}-2`)
  check('★★ 把那段原话整段贴回来：不弹卡、直接放行（Provider 1 次）', fullSend.card === null && fullSend.calls === 1, `card ${Boolean(fullSend.card)} provider ${fullSend.calls}`)
  const suppliedFold = String(foldedUser(fullSend.history)?.content ?? '')
  check('★ 补充放行时也如实说明：折叠块本身不是全文', suppliedFold.includes('不是全文') || suppliedFold.includes('原样补在最新一条消息里'), suppliedFold.slice(0, 60))
  check('★★ 补充放行也仍然写着「没有进入本次请求」', suppliedFold.includes('没有进入本次请求'))
  check('★ 补充放行不写进 confirmed（它不是「用户确认继续」）', gate.snapshot(fillSession).confirmed.length === 0)

  group('P0-1（2026-10-27）/ ⑪ 同一段原话从「折叠」退化成「整轮省略」：仍要阻断')
  /*
   * 真机验收逮到的洞（`10-27` 日志）：被拦的那条用户消息仍留在会话里 → 下次发送的历史多两条 →
   * 同一段原话从「折叠（摘要里留着开头结尾）」退化成「**整轮被省略**」。省略按设计不进
   * `lossy`，闸门就看不见 → 未确认也放行。这一组钉住补上的那条判据。
   *
   * 造数要让两次数出不同结果：第一次 `尾部 17 条 + 折 3 条 = 20`（恰好装得下 → 折叠），
   * 第二次 `尾部 19 条 + 3 条 = 22`（装不下 → 整轮丢弃）。
   */
  const dropSession = `g6-d-${Date.now()}`
  const longTurn = turnOf(overText, 30, '结论：读了一半')
  const shortTurns = Array.from({ length: 8 }, (_, i) => turnOf(`第 ${i + 2} 轮追问`, 0, '结论')).flat()
  const dropHistory = [...longTurn, ...shortTurns, { role: 'user', content: '接着做' }]
  const drop1 = await send(dropSession, dropHistory, `${dropSession}-1`)
  check('★ 夹具成立：第一次是「折叠」有损（lossy 非空）', drop1.lossy.length > 0, JSON.stringify(drop1.lossy))
  check('★★ 第一次：阻断 + Provider 0 次', Boolean(drop1.error) && drop1.calls === 0, `provider ${drop1.calls}`)
  const grown = [
    ...dropHistory,
    { role: 'assistant', content: '（这一轮没有发给模型：…）' },
    { role: 'user', content: '接着做' },
  ]
  const drop2 = await send(dropSession, grown, `${dropSession}-2`)
  check('★ 夹具成立：第二次 lossy 是空的（省略不进 lossy —— 正是要补的那条判据）', drop2.lossy.length === 0, JSON.stringify(drop2.lossy))
  check('★★ 第二次（整轮被省略）：仍阻断，Provider 0 次', Boolean(drop2.error) && drop2.calls === 0, `provider ${drop2.calls}`)
  check(
    '★★ 说明里写明「连摘要都没进请求」（不是含糊的「缺 N 字」）',
    String(drop2.error?.message ?? '').includes('连摘要都没进请求'),
    String(drop2.error?.message ?? '').slice(0, 70),
  )
  const drop3 = await send(dropSession, grown, `${dropSession}-3`, gate.CHOICE_CONTINUE)
  check('★★ 明确确认之后才放行（恢复路径仍在）', drop3.calls === 1 && Boolean(drop3.value), `provider ${drop3.calls}`)
  check('★ 确认后这条指纹进了 confirmed', gate.snapshot(dropSession).confirmed.length === 1, JSON.stringify(gate.snapshot(dropSession)))

  group('P0-1（第 6 轮）/ ⑩ 接线：闸在 loop.run 之前，且只有卡片动作能写 confirmed')
  const runSrc = readFileSync(join(ROOT, 'electron/handlers/chat-run.cjs'), 'utf8')
  const gateSrc = readFileSync(join(ROOT, 'electron/core/fold-gate.cjs'), 'utf8')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check('★★ 闸在 loop.run 之前', runSrc.indexOf('foldGate.inspect(') > 0 && runSrc.indexOf('foldGate.inspect(') < runSrc.indexOf('loop.run('))
  check('★★ 阻断时真的去问用户（askContinue → 确认卡）', /await askContinue\(/.test(runSrc) && runSrc.includes('askClarify('))
  check('★★ 只有拿回 true 才 confirm（没点就停手）', /if \(!go\) throw new Error\(gate\.message\)/.test(runSrc) && runSrc.includes('foldGate.confirm('))
  check('★★ 闸里「已提示」与「已获确认」是两个容器', /notified: new Map\(\)/.test(gateSrc) && /confirmed: new Set\(\)/.test(gateSrc))
  check('★★ 放行判定只看 confirmed（折叠类：提示过不算同意）', /!one\.confirmed\.has\(item\.fp\)/.test(gateSrc))
  check('★★ 「整轮消失」这条判据也排除已确认的', /!one\.confirmed\.has\(fp\)/.test(gateSrc), 'gone 分支要排除 confirmed')
  check('★★ 阻断文字进当前对话（catch 发 error 事件）', /emit\(\{\s*type:\s*'error',\s*message/.test(chatSrc))
  check('★ 补充判据是逐字包含（不是关键词）', gateSrc.includes('text.includes(middle)'))
}
