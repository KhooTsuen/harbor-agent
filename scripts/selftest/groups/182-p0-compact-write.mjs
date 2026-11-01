/**
 * 自检 / P0-2 压缩摘要进入正常发送 + 写盘结果如实返回（2026-10-23）
 *
 * ── 为什么单独一组 ───────────────────────────────────────────
 *
 * 原来它和 P0-1（历史窗口）在同一个文件 `180-p0-window-compact.mjs` 里。
 * 2026-10-23 第二轮给 P0-1 补了「折叠摘要」那一整块判据之后，那个文件到 335 行
 * （硬约束 #2 是 300），所以按「判据属于哪一件事」拆成两组：
 *
 *   · 180 = 历史窗口（按完整轮次截取 + 装不下就折叠）
 *   · 182 = 压缩（有效压缩点 + 两条发送路同形 + 写盘结果）
 *
 * 两组不共享状态（各自建会话、各自清），拆分没有改任何断言。
 *
 * ── 这一组钉什么 ─────────────────────────────────────────────
 *
 * ① **有效压缩点只有一处定义**（`compact-point.cjs`）：取「覆盖最靠后」的那次，
 *    不是「数组末条」；`upTo: 0` 不算压过。
 * ② **两条发送路同形**：内核 `session-read.toApiMessages` 与渲染层
 *    `stores/thread/history.ts` 的摘要段文案**逐字一致**，且都真的带上摘要。
 * ③ **写盘结果如实返回**：会话不存在 / 真的写不进去 → `{ ok: false, error }`。
 *    这是「假压缩成功」的内核那一半（渲染层那一半在
 *    `src/stores/thread/__tests__/compactWritethrough.test.ts`）。
 * ④ **重启后读取**：重新从磁盘 load → 压缩点还在、发送的历史仍带摘要、
 *    摘要进的是**实际请求载荷**（`buildChatBody` 拼出来的那个 body）。
 */

import { check, group } from '../harness.mjs'
import { join, readFileSync, require, ROOT, session } from '../env.mjs'

const pointCore = require(join(ROOT, 'electron/core/compact-point.cjs'))
/* 请求体的唯一构造函数（llm.cjs 就是用它拼 body 的） */
const bodyCore = require(join(ROOT, 'electron/core/llm-body.cjs'))

/** 交给模型的那一份 → **发送前的实际请求载荷**（线上会发出去的内容） */
function payloadOf(messages) {
  return JSON.stringify(bodyCore.buildChatBody({ model: 'probe-model', messages, stream: true }))
}

export async function run() {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

  group('P0-2 / 有效压缩点只认「覆盖最靠后」的那次')
  const best = pointCore.effectivePoint([
    { upTo: 30, summary: '覆盖 30' },
    { upTo: 8, summary: '覆盖 8' },
    { upTo: 0, summary: '空的' },
  ])
  check(
    '★ 取 upTo 最大的那条（不是数组末条）',
    best.upTo === 30 && best.summary === '覆盖 30',
    JSON.stringify(best),
  )
  check('没有有效压缩点 → null', pointCore.effectivePoint([]) === null)
  check('upTo 全是 0 → null（不许拿空压缩点当压缩过）', pointCore.effectivePoint([{ upTo: 0 }]) === null)
  check(
    '内存形状（compactUpTo + reasoning）也认',
    pointCore.effectivePoint([{ compactUpTo: 5, reasoning: '内存摘要' }]).summary === '内存摘要',
  )

  const summaryMsg = pointCore.summaryMessageOf(best)
  check('摘要段是 system 角色（背景，不是这轮谁说的话）', summaryMsg.role === 'system')
  check('摘要段带「不是新指令」的边界提示', summaryMsg.content.startsWith(pointCore.SUMMARY_PREFIX))

  group('P0-2 / 两条发送路必须同形（文案逐字一致 + 都真的带上摘要）')
  const rendererSrc = read('src/stores/thread/history.ts')
  const rendererPrefix = /SUMMARY_PREFIX = '([^']+)'/.exec(rendererSrc)?.[1] ?? ''
  check(
    '★★ 渲染层与内核的摘要段开头**逐字一致**',
    rendererPrefix !== '' && rendererPrefix === pointCore.SUMMARY_PREFIX,
    JSON.stringify({ kernel: pointCore.SUMMARY_PREFIX, renderer: rendererPrefix }),
  )
  check(
    '★ 渲染层不再把 system 一律跳过（那会丢掉压缩点摘要）',
    !rendererSrc.includes("m.role === 'system') continue"),
  )
  check(
    '★ 渲染层用同一份「有效压缩点」判定（不自己再扫一遍）',
    rendererSrc.includes('effectiveCompactPoint'),
  )

  /* 磁盘路径真跑：压过之后，发送用的历史里必须有摘要、且压缩点之前的不再逐条带 */
  const compacted = session.create({ title: 'P0-2 压缩', mode: 'pair' })
  session.append(compacted.id, { role: 'user', content: '很早以前的问题（应被摘要覆盖）' })
  session.append(compacted.id, { role: 'assistant', content: '很早以前的回答（应被摘要覆盖）' })
  session.append(compacted.id, { role: 'user', content: '压过之后的提问' })
  session.append(compacted.id, { role: 'assistant', content: '压过之后的回答' })
  const wrote = session.appendCompact(compacted.id, '## Goal\n把这件事做完', 2)
  check('★ 压缩点写盘结果如实返回 ok', wrote?.ok === true, JSON.stringify(wrote))

  const afterCompact = session.toApiMessages(compacted.id, 20)
  const summaryInApi = afterCompact.find(
    (m) => m.role === 'system' && String(m.content).includes('把这件事做完'),
  )
  check('★★ 正常发送路径真的带上了摘要（不再是界面说有、实际没有）', Boolean(summaryInApi))
  check('★ 摘要段在历史最前面（是背景，不是插入对话中间）', afterCompact[0]?.role === 'system')
  check(
    '★ 压缩点之前的旧消息不再逐条重复塞一遍（避免「摘要 + 全文」两份）',
    !afterCompact.some((m) => String(m.content).includes('很早以前的问题')),
  )
  check(
    '★★ 摘要真的进了实际请求载荷（不是只留在磁盘上）',
    payloadOf(afterCompact).includes('把这件事做完'),
  )

  group('P0-2 / 写盘失败必须如实报失败（「假压缩成功」的内核那一半）')
  /* 合法但不存在（id 形状要过 fileFor 的白名单，否则抛的是「id 不合法」而不是「会话不存在」） */
  const missing = session.appendCompact('sess_0000000000nope', '摘要', 3)
  check(
    '★ 会话不存在时 appendCompact 返回 ok:false（不再静默成功）',
    missing?.ok === false && typeof missing.error === 'string',
    JSON.stringify(missing),
  )
  /*
   * 写盘出错（目录不可写 / 磁盘满）时也不能装作写过。
   * 用「把文件变成目录」造一个 append 一定失败的现场：比改权限稳，也不依赖平台。
   */
  const broken = session.create({ title: 'P0-2 写不进去', mode: 'pair' })
  const brokenFile = session.fileFor(broken.id)
  session.remove(broken.id)
  const fsCore = require('node:fs')
  fsCore.mkdirSync(brokenFile, { recursive: true })
  const brokenResult = session.appendCompact(broken.id, '写不进去的摘要', 1)
  check(
    '★ 真的写不进去时返回 ok:false + 原因（而不是 ok:true）',
    brokenResult?.ok === false && String(brokenResult.error).length > 0,
    JSON.stringify(brokenResult),
  )
  fsCore.rmdirSync(brokenFile)
  check('写失败的现场已清理（没有留下半条压缩记录）', session.load(broken.id) === null)

  group('P0-2 / 重启后读取：摘要真的在磁盘上、也真的会进请求')
  /* 重新从磁盘 load 一次 = 重启后的那条路（load 只读文件，不碰进程内状态） */
  const reread = session.load(compacted.id)
  const pointOnDisk = pointCore.effectivePoint(reread?.compacts ?? [])
  check(
    '★★ 重读磁盘能看到那条压缩点（写成功过才有，界面说「已压缩」时磁盘必须也有）',
    pointOnDisk?.summary.includes('把这件事做完') === true,
    JSON.stringify(pointOnDisk),
  )
  const afterRestart = session.toApiMessages(compacted.id, 20)
  check(
    '★★ 重启后发送的那份历史仍然带摘要',
    afterRestart[0]?.role === 'system' && String(afterRestart[0].content).includes('把这件事做完'),
  )
  check('★★ 重启后摘要也在实际请求载荷里', payloadOf(afterRestart).includes('把这件事做完'))

  session.remove(compacted.id)
  check('测试会话已清理', session.load(compacted.id) === null)
}
