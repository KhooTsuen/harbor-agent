import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   AG-024：发送不阻塞输入 —— 接线守卫

   文档三条要求：
     ① Composer 保持可用
     ② 用户可以准备下一条消息
     ③ Agent 不得锁死输入框

   现状已经满足：textarea 没有 disabled/readOnly；sendMessage 只挡
   「当前对话自己在跑」，不拦别的对话。

   这个文件防的是**回归** —— 「顺手给 textarea 加 disabled」或者「把
   sendMessage 改成全局拦截」都是看着像「修 bug」的改动，但会把 AG-024
   整个推翻。用断言把这两件事钉死。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const composer = readFileSync(join(ROOT, 'src/components/chat/Composer.tsx'), 'utf8')
const store = readFileSync(join(ROOT, 'src/stores/useThreadStore.ts'), 'utf8')

/** 从 <textarea 到 /> 的那一段 */
function textareaBlock(src: string): string {
  const start = src.indexOf('<textarea')
  if (start === -1) return ''
  const end = src.indexOf('/>', start)
  return src.slice(start, end)
}

describe('AG-024 接线守卫', () => {
  it('★ textarea 永不锁定（没有 disabled / readOnly）', () => {
    const block = textareaBlock(composer)
    expect(block).not.toContain('disabled')
    expect(block).not.toContain('readOnly')
    expect(block).not.toContain('readonly')
  })

  it('★ 发送只挡「当前对话自己在跑」，不是全局拦截', () => {
    /* 关键断言：拦的是 getActiveThread 的 status，不是 sendingThreads.length */
    expect(store).toContain("getActiveThread(app)?.status === 'running'")
    expect(store).not.toContain('if (get().sendingThreads.length > 0) return')
    expect(store).not.toContain('if (app.sendingThreads.length > 0) return')
  })

  it('★ 别的对话在跑时，这条照样能发（注释里写明了这条纪律）', () => {
    expect(store).toContain('别的对话在跑不该拦着这条')
  })

  it('★ 发送按钮只在「当前对话 sending」时禁用，不影响 textarea', () => {
    expect(composer).toContain('canSend = !sending && hasContent && !tooLong')
  })
})
