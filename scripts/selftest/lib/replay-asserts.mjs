/**
 * 历史回放：工具记录走**结构化** tool 消息（2026-10-21 从 01-basics.mjs 拆出 —— 那边过 300 行）
 *
 * ⚠️ 这是**子模块**，不是自检组：由 `groups/01-basics.mjs` 调用。
 *    放在 `lib/` 下正是为了不被「groups/ 里每个文件都必须在清单上」那条挡住。
 *
 * ── 为什么改口径 ────────────────────────────────────────────
 *
 * 旧断言钉的是「拼接文本里的换行是真换行」（`[此前工具执行记录]\n`）。为什么不保留：
 * **拼接本身就是病根** —— 模型在历史里反复看到「assistant 消息后面挂一段工具清单」，
 * 就把它当成「回答该有的格式」照着复述。真机量出来的：一条 37,898 字符的回答里，
 * 31,215 字是 52 次工具调用的原始输出（合计 70,493 字），界面上就是一整块
 * 几乎没有分段的连续文字。
 *
 * 现在改钉协议形状 —— 这三条错了都**只在真机上现形**（tsc 与 lint 都看不出）。
 */

/**
 * @param {{ check: Function, session: object }} env
 */
export default function register({ check, session }) {
  /*
   * ① 工具结果走 `role:'tool'`，正文里**不许**再出现那个标记串
   * ② assistant 的 `tool_calls[].id` 与 tool 的 `tool_call_id` **逐个配对**
   *    （配对不上 → 上游 400，而且只在上传那一刻才炸）
   * ③ `arguments` 是合法 JSON **字符串**（不是对象，也不是空串）
   * ④ 工具输出仍在（只是换了载体）—— 不然模型看不到自己干过什么
   */
  const replayThread = session.create({ title: '重放', mode: 'pair' })
  session.append(replayThread.id, { role: 'user', content: '跑命令' })
  session.append(replayThread.id, {
    role: 'assistant',
    content: '好了',
    toolRuns: [{ name: 'run_shell', ok: true, output: 'l1\nl2' }],
  })
  const replayMsgs = session.toApiMessages(replayThread.id, 10)
  const asst = replayMsgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
  const toolMsg = replayMsgs.find((m) => m.role === 'tool')

  check('★★★ 工具记录走结构化 tool 消息（不再是文本拼接）', Boolean(asst) && Boolean(toolMsg))
  check(
    '★★★ 正文里不再出现 [此前工具执行记录] 那个标记串',
    !replayMsgs.some(
      (m) => typeof m.content === 'string' && m.content.includes('[此前工具执行记录]'),
    ),
  )
  check(
    '★★★ tool_calls[].id 与 tool_call_id 配对',
    Boolean(asst) &&
      asst.tool_calls.length === 1 &&
      asst.tool_calls[0].id === toolMsg.tool_call_id,
    JSON.stringify({ calls: asst?.tool_calls?.map((c) => c.id), toolCallId: toolMsg?.tool_call_id }),
  )

  let argsOk = false
  try {
    argsOk =
      Boolean(asst) &&
      typeof asst.tool_calls[0].function.arguments === 'string' &&
      (JSON.parse(asst.tool_calls[0].function.arguments), true)
  } catch {
    argsOk = false
  }
  check('★★ arguments 是合法 JSON 字符串', argsOk)

  check(
    '★★ 工具输出仍在（只是换了载体）',
    Boolean(toolMsg) && toolMsg.content.includes('l1') && toolMsg.content.includes('l2'),
  )

  /*
   * ★ 可重复性：同一份历史回放两次，合成 id 必须一模一样。
   *   否则上游的前缀缓存每次都失效 —— 长对话会明显变慢，而这一点在功能上「看起来正常」。
   */
  const again = session.toApiMessages(replayThread.id, 10)
  const idsOf = (msgs) =>
    msgs.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id))
  check(
    '★★ 回放 id 可重复（两次结果相同 —— 前缀缓存不失效）',
    JSON.stringify(idsOf(replayMsgs)) === JSON.stringify(idsOf(again)),
    JSON.stringify({ first: idsOf(replayMsgs), second: idsOf(again) }),
  )

  /* 没有工具记录的助手消息必须还是普通一条 —— 别把空 tool_calls 发上去 */
  session.append(replayThread.id, { role: 'assistant', content: '纯文本回答' })
  const plain = session.toApiMessages(replayThread.id, 10).at(-1)
  check(
    '★★ 没有工具记录时不发空 tool_calls',
    plain?.role === 'assistant' && plain.tool_calls === undefined,
    JSON.stringify(plain),
  )

  session.append(replayThread.id, {
    role: 'assistant',
    content: '看图后执行',
    images: ['data:image/png;base64,AA=='],
    toolRuns: [{ name: 'read_image', ok: true, output: '已读' }],
  })
  const imageReplay = session.toApiMessages(replayThread.id, 10)
  const imageAssistant = imageReplay.findLast((m) => m.role === 'assistant' && m.tool_calls)
  check(
    '★★ 含图助手历史回放保留多模态内容',
    Array.isArray(imageAssistant?.content) &&
      imageAssistant.content.some((part) => part.type === 'image_url' && part.image_url?.url === 'data:image/png;base64,AA=='),
  )
  session.remove(replayThread.id)
}
