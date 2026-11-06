/**
 * 上下文链路回放：真实会话 → 两层裁剪 → `assemble` → **模型最终看到什么**
 *
 * ── 为什么进仓库（P1-A/B，2026-11-07）──────────────────────────
 *
 * 这个脚本原本是 P0 调查时的一次性探针（`tmp/p0-path-baseline.cjs`），而 `tmp/*` 不进
 * 仓库（`.gitignore`）—— 换台机器就没了，「改前 / 改后」的对比证据也跟着没了。
 * P0 报告第 10 节点名要把它挪进来：它是唯一能回答「模型到底看到了什么」的工具。
 *
 * 只读：不写任何文件，不联网，不碰 `data/`。
 *
 * ── 怎么跑 ────────────────────────────────────────────────────
 *
 *   node tools/dev/context-replay.mjs "E:\Harbor\data\sessions\sess_xxx.jsonl"
 *   node tools/dev/context-replay.mjs a.jsonl b.jsonl        # 多份一起比
 *
 * 参数（可选，都能不传）：
 *   --base=52428     输入预算基准（token）。默认 DeepSeek deepseek-chat = 65536 × 0.8
 *   --limit=20       assistant.historyLimit（按消息条数）
 *   --say=继续        把这句当作「本轮用户刚说」，追加在最后
 *
 * ⚠️ 输出里每处正文最多 90 字，**只看形状不搬正文**。要看全文去会话文件里读。
 */
import { createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const { takeTurns, describeWindow } = await import(
  new URL('../../electron/core/history-window.cjs', import.meta.url).href
).then((m) => m.default ?? m)
const builder = (await import(new URL('../../electron/core/context-builder.cjs', import.meta.url).href))
  .default

const argOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const BASE = Number(argOf('base', 52428))
const LIMIT = Number(argOf('limit', 20))
const SAY = argOf('say', '继续')

const line = (s) => console.log(s)
const sumChars = (list) => list.reduce((s, m) => s + String(m.content ?? '').length, 0)

/**
 * 复刻渲染层 `history.ts` 的 `buildHistory`：工具记录展开成
 * `assistant(tool_calls)` + N 条 `tool`，每条 output 截 2000。
 * （与 `session-replay.replayToolRuns` 同形 —— 两条路喂给模型的必须是一种形状）
 */
function buildHistory(messages) {
  const out = []
  for (const m of messages) {
    if (!(m.role === 'user' || m.role === 'assistant')) continue
    const runs = m.role === 'assistant' && Array.isArray(m.toolRuns) ? m.toolRuns : []
    if (runs.length === 0) {
      out.push({ role: m.role, content: String(m.content ?? '') })
      continue
    }
    const suffix = String(m.diskKey ?? m.key ?? m.id ?? '').slice(-8) || 'r'
    const callIdOf = (k) => `replay_${suffix}_${k}`
    out.push({
      role: 'assistant',
      content: String(m.content ?? ''),
      tool_calls: runs.map((t, k) => ({
        id: callIdOf(k),
        type: 'function',
        function: { name: t.name, arguments: '{}' },
      })),
    })
    runs.forEach((t, k) => {
      out.push({
        role: 'tool',
        tool_call_id: callIdOf(k),
        content: `${t.name}: ${t.ok ? '成功' : '失败'}${t.output ? `\n${String(t.output).slice(0, 2000)}` : ''}`,
      })
    })
  }
  return out
}

/** 协议体检：孤儿 tool / 悬空 tool_calls */
function protocolOf(messages) {
  const callIds = new Set()
  for (const m of messages) for (const call of m.tool_calls ?? []) callIds.add(call.id)
  const tools = messages.filter((m) => m.role === 'tool')
  return {
    orphans: tools.filter((m) => !callIds.has(m.tool_call_id)).length,
    dangling: [...callIds].filter((id) => !tools.some((m) => m.tool_call_id === id)).length,
  }
}

async function load(file) {
  const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  const out = []
  for await (const raw of rl) {
    if (!raw.trim()) continue
    try {
      const row = JSON.parse(raw)
      if (row.type === 'message') out.push(row)
    } catch {
      /* 坏行跳过（会话文件是只追加的，尾行可能是半截） */
    }
  }
  return out
}

async function runOne(file) {
  const messages = await load(file)
  const users = messages.filter((m) => m.role === 'user')
  const raw = buildHistory(messages)
  if (SAY) raw.push({ role: 'user', content: SAY })

  line('')
  line('════════════════════════════════════════════════════════════')
  line(`文件：${path.basename(file)}`)
  line(`磁盘 message ${messages.length} 条（user ${users.length}）→ 展开 ${raw.length} 条 / ${sumChars(raw)} 字符`)

  /* 第一层：按条数（轮次边界）切 + 折叠 */
  const w = takeTurns(raw, LIMIT, { minTurns: 1 })
  line('')
  line(`【第一层】windowHistory(limit=${LIMIT} 条消息)`)
  line(`  ${raw.length} → ${w.kept.length} 条 / ${sumChars(w.kept)} 字符`)
  line(`  省略 ${w.droppedTurns} 轮 · 折叠 ${w.foldedTurns} 轮 · 有损 ${w.lostChars} 字`)
  line(`  说明：${describeWindow(w, raw) || '（无）'}`)
  line(
    `  角色：user ${w.kept.filter((m) => m.role === 'user').length} · ` +
      `有正文的 assistant ${w.kept.filter((m) => m.role === 'assistant' && String(m.content ?? '').trim()).length} · ` +
      `tool ${w.kept.filter((m) => m.role === 'tool').length}`,
  )

  /* 第二层：按消息组挑（context-groups）+ 字符额度 */
  const asm = builder.assemble({ maxTokens: BASE, messages: w.kept })
  line('')
  line(`【第二层】assemble（对话层额度 ${asm.estimates.conversationBudget} 字符）`)
  line(`  ${w.kept.length} → ${asm.messages.length} 条 / ${sumChars(asm.messages)} 字符`)
  line(
    `  角色：user ${asm.messages.filter((m) => m.role === 'user').length} · ` +
      `assistant ${asm.messages.filter((m) => m.role === 'assistant').length} · ` +
      `tool ${asm.messages.filter((m) => m.role === 'tool').length}`,
  )
  line(`  droppedMessages=${asm.estimates.droppedMessages}（其中记录不完整 ${asm.estimates.invalidMessages}）`)
  const proto = protocolOf(asm.messages)
  line(`  协议体检：孤儿 tool ${proto.orphans} · 悬空 tool_calls ${proto.dangling}`)
  line(
    `  估算：对话层 ${asm.estimates.conversationChars} 字符 · 整份输入 ${asm.estimates.chars} 字符 ` +
      `≈ ${asm.estimates.tokens} token（chars/3，**估算**，不是计费 token）`,
  )

  /* 模型最终看到什么 */
  line('')
  line('【最终请求里模型能看到的内容】')
  for (const m of asm.messages.filter((x) => x.role === 'user')) {
    line(`  [user] ${String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 90)}`)
  }
  for (const m of asm.messages.filter((x) => x.role === 'assistant')) {
    const calls = (m.tool_calls ?? []).length
    const body = String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 90)
    line(`  [assistant]${calls ? ` (tool_calls×${calls})` : ''} ${body || '(空)'}`)
  }
  line(`  [tool] 共 ${asm.messages.filter((x) => x.role === 'tool').length} 条`)

  const firstText = String(messages.find((m) => m.role === 'user')?.content ?? '')
  const lastUserText = String(messages.filter((m) => m.role === 'user').at(-1)?.content ?? '')
  const has = (t) => asm.messages.some((m) => String(m.content ?? '').includes(t.slice(0, 40)))
  line(`  ★ 任务最初那句诉求还在不在：${firstText && has(firstText) ? '在' : '不在'}`)
  line(`  ★ 上一轮用户最后说的那句还在不在：${lastUserText && has(lastUserText) ? '在' : '不在'}`)
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (files.length === 0) {
  line('用法：node tools/dev/context-replay.mjs <会话.jsonl> [更多.jsonl] [--base=52428] [--limit=20] [--say=继续]')
  line(`仓库根：${ROOT}`)
  process.exit(2)
}
for (const f of files) {
  if (!existsSync(f)) {
    line(`跳过（文件不存在）：${f}`)
    continue
  }
  await runOne(f)
}
