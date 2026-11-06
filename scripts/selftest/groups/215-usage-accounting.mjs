/**
 * 自检 / P1-B：上下文**用量口径**（2026-11-07）
 *
 * ── 这一组钉什么 ────────────────────────────────────────────
 *
 * P0 查出的第三个病灶：**三套用量口径互不相认**。
 *
 *   · 界面那个圈只累加 `message.content.length`（老 `estimateMessages`）；
 *   · 真实请求体要**展开工具记录**（`history.buildHistory` → assistant(tool_calls) + N 条 tool，
 *     每条 output 截 2000）；
 *   · 同一份会话：界面 55.4% vs 实际 127.6%（低估 2.3 倍）；另一份 145.9% vs 912.9%（6.3 倍）；
 *   · 自动压缩线（0.6）判的就是那个偏小的数 —— 于是「圈里才一半，它已经超了」。
 *
 * 所以这里钉两件事：
 *   ① `assemble` 返回的 `estimates` **四项分开报**，且彼此可对照（不是拍的一个总数）；
 *   ② 渲染层的口径文件是**唯一一处**，并且写明「是估算，不是计费 token」。
 *
 * ⚠️ 渲染层与内核**逐条相等**这件事在 `src/stores/thread/__tests__/contextUsageDrift.test.ts`
 *    里钉（那边能 import `.ts`，这边不能）—— 本组只钉「内核这一侧的形状和文字口径」。
 *    两边都钉才不会出现「内核改了、渲染层没跟」。
 */

import { check, group } from '../harness.mjs'
import { join, readFileSync, require, ROOT } from '../env.mjs'

const builder = require(join(ROOT, 'electron/core/context-builder.cjs'))
const text = require(join(ROOT, 'electron/core/context-text.cjs'))

/** 一组「assistant(tool_calls) + N 条 tool」，正文可空 */
function toolGroup(ids, body = '') {
  return [
    {
      role: 'assistant',
      content: body,
      tool_calls: ids.map((id) => ({
        id,
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      })),
    },
    ...ids.map((id) => ({ role: 'tool', tool_call_id: id, content: `read_file: 成功\n${'y'.repeat(700)}` })),
  ]
}

export async function run() {
  const assembled = builder.assemble({
    maxTokens: 52428,
    messages: [
      { role: 'user', content: '把那 30 个文件都读一遍' },
      ...Array.from({ length: 30 }, (_, i) => toolGroup([`c${i}`])).flat(),
      { role: 'assistant', content: '30 个都读完了。' },
    ],
  })
  const est = assembled.estimates

  group('P1-B / 估算四项分开报，并且是估算')
  check(
    '★ 估算给出四样东西：整份输入 / 系统各层 / 对话层 / 对话层额度',
    est.chars > 0 && est.systemChars >= 0 && est.conversationChars > 0 && est.conversationBudget > 0,
    JSON.stringify(est),
  )
  check(
    '★ 整份输入 = 系统各层 + 对话层（可对照，不是拍的数字）',
    est.chars === est.systemChars + est.conversationChars,
    `${est.chars} vs ${est.systemChars}+${est.conversationChars}`,
  )
  check(
    '★ token 数与 chars 同一套换算（chars/3），明说是估算',
    est.tokens === Math.ceil(est.chars / 3),
    `${est.tokens} / ${Math.ceil(est.chars / 3)}`,
  )
  check(
    '★ 对话层实际占用不超过它的额度（超了就是预算没管住）',
    est.conversationChars <= est.conversationBudget,
    `${est.conversationChars} / ${est.conversationBudget}`,
  )
  check(
    '★ 全部是**估算**：给的是 chars + 换算出来的 token，不是供应商返回的计费数',
    typeof est.chars === 'number' && est.tokens === builder.estimateTokensOf(est.chars),
  )

  group('P1-B / 工具记录真的被计进「整份输入」')
  /*
   * 这一条是口径有没有换对的分水岭：只看正文的算法在「30 次工具、正文全空」时
   * 会算出几百字符；按请求体口径必须上到几万。数字不写死（见硬约束 8），
   * 但比例可以钉：工具输出 30×700 字符，对话层必须远大于正文总和。
   */
  const bodyChars = assembled.messages.reduce((sum, m) => sum + String(m.content ?? '').length, 0)
  check(
    '★★ 对话层估算远大于「只加正文」（工具输出是主体，这正是以前漏掉的部分）',
    est.conversationChars > bodyChars,
    `对话层 ${est.conversationChars} vs 正文 ${bodyChars}`,
  )
  check(
    '★★ 那 30 条工具输出真的在请求里（不是只算了个数）',
    assembled.messages.filter((m) => m.role === 'tool').length === 30 &&
      assembled.messages.some((m) => String(m.content).includes('y'.repeat(50))),
  )

  group('P1-B / 用量口径的源码守位')
  const usageSrc = readFileSync(join(ROOT, 'src/stores/thread/contextUsage.ts'), 'utf8')
  check(
    '★ 渲染层口径独立成文件（不再埋在 compact.ts 里只算正文）',
    usageSrc.includes('requestCharsOf') && usageSrc.includes('toolRuns'),
  )
  check(
    '★ 渲染层与内核的形状开销同值（OUTPUT_CAP / MESSAGE_OVERHEAD / CALL_OVERHEAD / IMAGE_COST）',
    usageSrc.includes('OUTPUT_CAP = 2000') &&
      usageSrc.includes('MESSAGE_OVERHEAD = 12') &&
      usageSrc.includes('CALL_OVERHEAD = 24') &&
      usageSrc.includes(`IMAGE_COST = ${text.IMAGE_COST}`) &&
      text.MESSAGE_OVERHEAD === 12 &&
      text.CALL_OVERHEAD === 24,
  )
  check('★ 渲染层口径文件写明「是估算，不是计费 token」', usageSrc.includes('不是 API 计费 token'))
  check(
    '★ 内核只有一个地方算消息大小（context-text），builder 不再自己算',
    typeof text.sizeOfMessage === 'function' &&
      !readFileSync(join(ROOT, 'electron/core/context-builder.cjs'), 'utf8').includes('function sizeOf'),
  )
  /*
   * 回放 id 的公式也只有一处：用量要按 id 的真实长度算进预算，
   * 两处各写一份，症状是「显示 3.4 万、实际发 3.5 万」且没人发现。
   */
  check(
    '★ 回放 id 的公式只有一处（history 从 contextUsage 借，不自己拼）',
    usageSrc.includes('export function replayCallIdOf') &&
      readFileSync(join(ROOT, 'src/stores/thread/history.ts'), 'utf8').includes('replayCallIdOf(') &&
      !readFileSync(join(ROOT, 'src/stores/thread/history.ts'), 'utf8').includes('`replay_${'),
  )
  check(
    '★ 渲染层与内核「逐条相等」有测试盯着（不是靠人记得）',
    readFileSync(join(ROOT, 'src/stores/thread/__tests__/contextUsageDrift.test.ts'), 'utf8').includes(
      'sizeOfMessage',
    ),
  )
}
