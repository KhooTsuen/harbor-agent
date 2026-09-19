import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   AG-026：Composer Draft 持久化 —— 接线守卫

   核心是「草稿 per-thread」：每个线程有自己的输入草稿，切换线程时保存旧的、
   恢复新的，绝不串。

   这里守两件事：
     ① drafts / switchDraft 存在，且 switchDraft 是把 input 存进旧线程、恢复新线程
     ② 切换草稿靠订阅 activeThreadId 变化（而不是散落在各处手动调）
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const store = readFileSync(join(ROOT, 'src/stores/useThreadStore.ts'), 'utf8')

describe('AG-026 接线守卫', () => {
  it('★ 草稿按线程存（drafts），不是全局一个 input 到处串', () => {
    expect(store).toContain('drafts: Record<string, string>')
    expect(store).toContain('switchDraft')
  })

  it('★ switchDraft 把当前 input 存进旧线程，再恢复新线程的草稿', () => {
    /* 保存：drafts[fromId] = s.input；恢复：input = drafts[toId] */
    expect(store).toContain('drafts[fromId] = s.input')
    expect(store).toContain("input: drafts[toId] ?? ''")
  })

  it('★ 切换草稿靠订阅 activeThreadId 变化（单一入口，不散落）', () => {
    expect(store).toContain('useAppStore.subscribe')
    expect(store).toContain('state.activeThreadId')
    expect(store).toContain('switchDraft(lastDraftThread, current)')
  })

  it('★ 草稿只在 activeThreadId 真变时才动，别的 state 变化不碰', () => {
    expect(store).toContain('if (current === lastDraftThread) return')
  })
})
