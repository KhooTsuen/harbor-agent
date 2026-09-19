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

describe('AG-024/025 接线守卫', () => {
  it('★ textarea 永不锁定（没有 disabled / readOnly）', () => {
    const block = textareaBlock(composer)
    expect(block).not.toContain('disabled')
    expect(block).not.toContain('readOnly')
    expect(block).not.toContain('readonly')
  })

  it('★ busy 判断按「对话」来，不是全局拦截', () => {
    /* 关键：拦的是当前对话在 sendingThreads 里，不是全局 sendingThreads.length */
    expect(store).toContain('get().sendingThreads.includes(threadId)')
    expect(store).not.toContain('if (get().sendingThreads.length > 0) return')
  })

  it('★ AG-025：当前对话在跑时，消息**入队**而不是丢弃', () => {
    expect(store).toContain('enqueueMessage(threadId, raw)')
    /* 而且要给回执（AG-032 把措辞与文档对齐成「已加入队列」）*/
    expect(store).toContain('已加入队列')
  })

  it('★ 发送按钮不再拿 sending 卡住（跑着时是「排队」），textarea 永不锁定', () => {
    expect(composer).toContain('canSend = hasContent && !tooLong')
  })
})
