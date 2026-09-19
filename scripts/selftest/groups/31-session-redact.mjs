import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync, writeFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   会话 JSONL 落盘脱敏

   0.90.0 开始助手回复会落盘（含 Tool 结果），真机检查时发现：
   session-write 里虽然有 scrubLine，却是**定义+导出、无人调用**，而且
   直接把对象传给它还会先变成 "[object Object]"，不能简单套一下。

   这一组覆盖：新建、追加消息、会话状态、压缩点、整体重写与长 Tool 数组。
   ══════════════════════════════════════════════════════════════ */

const session = require(join(ROOT, 'electron/core/session.cjs'))

export async function run() {
  group('会话落盘脱敏')

  /* 四条写路：create/writeLines、append、appendState、appendCompact */
  const secureThread = session.create({
    title: '安全测试 sk-aaaaaaaaaaaaaaaaaaaaaaaa',
    mode: 'pair',
  })
  const manyTools = Array.from({ length: 55 }, (_, i) => ({
    id: `tool-${i}`,
    name: 'read_file',
    ok: true,
    output: i === 3 ? 'Bearer abcdefghijklmnopqrstuvwxyz' : `result-${i}`,
  }))
  session.append(secureThread.id, {
    role: 'assistant',
    content: 'key = sk-bbbbbbbbbbbbbbbbbbbbbbbb',
    toolRuns: manyTools,
    extras: { apiKey: 'ordinary-value-123' },
  })
  session.appendState(secureThread.id, {
    currentFocus: 'password=visible-password-123',
  })
  session.appendCompact(secureThread.id, 'Token abcdefghijklmnopqrstuvwxyz', 2)

  const secureRaw = readFileSync(session.fileFor(secureThread.id), 'utf8')
  check('★ 会话文件不含内容里的 key', !secureRaw.includes('sk-bbbbbbbbbbbbbbbbbbbbbbbb'))
  check('★ 会话文件不含 meta 标题里的 key', !secureRaw.includes('sk-aaaaaaaaaaaaaaaaaaaaaaaa'))
  check('★ 会话文件不含 Bearer', !secureRaw.includes('abcdefghijklmnopqrstuvwxyz'))
  check('★ 会话文件不含敏感字段原值', !secureRaw.includes('ordinary-value-123'))
  check('★ conversation_state 也脱敏', !secureRaw.includes('visible-password-123'))
  check('会话文件留下脱敏标记', secureRaw.includes('已隐藏'))

  const secureLoaded = session.load(secureThread.id)
  check(
    '★ 落盘脱敏不截第 51 条以后的 Tool 记录',
    secureLoaded?.messages[0]?.toolRuns?.length === 55,
    String(secureLoaded?.messages[0]?.toolRuns?.length),
  )
  session.remove(secureThread.id)

  /* 旧文件已有明文密钥：改标题触发整体重写时也必须顺手清掉 */
  const legacyThread = session.create({ title: '旧会话' })
  writeFileSync(
    session.fileFor(legacyThread.id),
    `${JSON.stringify(legacyThread)}\n${JSON.stringify({
      type: 'message',
      role: 'user',
      content: 'Bearer legacy-secret-token-123456789',
    })}\n`,
    'utf8',
  )
  session.updateMeta(legacyThread.id, { title: '改标题并清旧密钥' })
  const legacyRaw = readFileSync(session.fileFor(legacyThread.id), 'utf8')
  check('★ 整体重写会清掉旧会话里的明文密钥', !legacyRaw.includes('legacy-secret-token'))
  session.remove(legacyThread.id)
}
