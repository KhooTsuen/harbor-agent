/*
 * 把装机版里「连续打开三个随机网页」那条对话的后半段捞出来看。
 * 会话文件在 E:\Harbor\data\sessions\*.jsonl（一行一条记录，meta + message）。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'E:\\Harbor\\data\\sessions'
const KEY = '连续打开三个随机网页'

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => join(DIR, f))

let hit = null
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (text.includes(KEY)) {
    const at = statSync(file).mtimeMs
    if (!hit || at > hit.at) hit = { file, at, text }
  }
}

const out = []
if (!hit) {
  out.push(`没找到标题含「${KEY}」的会话（共 ${files.length} 个会话文件）`)
} else {
  out.push(`会话文件：${hit.file}`)
  out.push(`最后写入：${new Date(hit.at).toLocaleString('zh-CN')}`)
  const lines = hit.text.split(/\r?\n/).filter(Boolean)
  out.push(`共 ${lines.length} 条记录`)
  const messages = []
  for (const line of lines) {
    try {
      const rec = JSON.parse(line)
      if (rec.type !== 'message') continue
      const role = rec.role === 'user' ? '【我】' : rec.role === 'assistant' ? '【它】' : '[系统]'
      const content = Array.isArray(rec.content) ? JSON.stringify(rec.content) : String(rec.content ?? '')
      messages.push({ role, content })
    } catch {
      /* 坏行跳过 */
    }
  }
  /* 流式分片会留下同一段的多个版本 —— 按前缀分组，每组**留最长的那条**（那才是写完的） */
  const groups = new Map()
  for (const m of messages) {
    const key = `${m.role}|${m.content.slice(0, 80)}`
    const prev = groups.get(key)
    if (!prev || m.content.length > prev.content.length) groups.set(key, m)
  }
  const unique = [...groups.values()]
  out.push(`消息 ${messages.length} 条（去重后 ${unique.length} 条），下面看最后 5 条：`)
  for (const m of unique.slice(-5)) {
    out.push(`\n${'─'.repeat(30)}\n${m.role}\n${m.content.slice(0, 2200)}`)
  }
  /* 最后一条「我」说的话 —— 用户当时让它干什么 */
  const lastUser = [...unique].reverse().find((m) => m.role === '【我】')
  if (lastUser) out.push(`\n${'─'.repeat(30)}\n最后一条用户消息：\n${lastUser.content.slice(0, 800)}`)
}

const report = out.join('\n')
writeFileSync('tmp/conv-three-pages.txt', report, 'utf8')
console.log(report.slice(0, 400))
