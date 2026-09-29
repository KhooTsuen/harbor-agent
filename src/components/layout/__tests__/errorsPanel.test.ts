import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatEntryForCopy, formatReport } from '@/lib/errorsApi'
import type { ErrorListResult } from '@/types/errors'

/* ══════════════════════════════════════════════════════════════
   右栏「错误」标签

   真机截图能证明「看得见」，这里守的是**接线**（测试照不到的那一层）：
   标签表、持久化白名单、IPC 清单 —— 少一处就是「点了没反应」或
   「重启后标签自己跳回审查」这类不报错的问题。

   另外钉住复制文案：用户是把这段**粘给别人**的，缺了位置和次数就没法查。
   ══════════════════════════════════════════════════════════════ */

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** 读源码时先把注释剥掉 —— 否则注释里提一句 `var(--danger)` 就会被误判
 *  （statusLanguage.test.ts 也是这么做的，踩过同一个坑） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}

const FIXTURE: ErrorListResult = {
  ok: true,
  dir: 'E:\\CodexWorkbench\\data\\errors',
  severityOrder: ['P0', 'P1', 'P2', 'P3'],
  severityLabel: { P0: 'P0 阻塞（必须人处理）', P1: 'P1 严重' },
  entries: [
    {
      key: 'observer|auth|ipc:x|登录失败',
      kind: 'auth',
      severity: 'P0',
      message: '登录失败：401',
      hint: '去设置里重填 API Key',
      origin: 'ipc',
      location: 'ipc:chat:send',
      firstSeen: 1_790_000_000_000,
      lastSeen: 1_790_000_060_000,
      count: 3,
      needsUser: true,
      retryable: false,
      raw: 'Error: 401 Unauthorized',
      context: { tool: '', taskId: 't1', sessionId: 's1' },
    },
  ],
  stats: { days: 7, files: 2, filesTotal: 2, raw: 5, unique: 1, total: 3 },
}

describe('错误面板：复制文案', () => {
  it('单条包含严重性 / 次数 / 位置 / 原文（缺了就没法查）', () => {
    const text = formatEntryForCopy(FIXTURE.entries[0])
    expect(text).toContain('[P0]')
    expect(text).toContain('auth × 3')
    expect(text).toContain('登录失败：401')
    expect(text).toContain('ipc:chat:send')
    expect(text).toContain('Error: 401 Unauthorized')
  })

  it('整份报告是 Markdown，带数据目录与统计（能直接粘给别人）', () => {
    const md = formatReport(FIXTURE)
    expect(md.startsWith('# 错误清单')).toBe(true)
    expect(md).toContain('data\\errors')
    expect(md).toContain('最近 7 天')
    expect(md).toContain('ipc:chat:send')
  })
})

describe('错误面板：接线（测试照不到的那一层）', () => {
  const rightPanel = read('src/components/layout/RightPanel.tsx')
  const types = read('src/types/index.ts')
  const settings = read('src/stores/useSettingsStore.ts')
  const channels = read('electron/ipc-channels.cjs')
  const preload = read('electron/preload.cjs')
  const panel = stripComments(read('src/components/layout/ErrorsPanel.tsx'))

  it('RightTab 里有 errors', () => {
    const line = types.split('\n').find((l) => l.includes('export type RightTab')) ?? ''
    expect(line).toContain("'errors'")
  })

  it('标签表里有一项，并且面板真的被渲染（不是只注册了没人用）', () => {
    expect(rightPanel).toContain("id: 'errors'")
    expect(rightPanel).toContain("activeRightTab === 'errors' ? <ErrorsPanel />")
  })

  it('★ 持久化白名单认 errors —— 不认的话重启会自己跳回「审查」', () => {
    expect(settings).toContain("s.lastRightTab === 'errors'")
  })

  it('★ IPC 通道清单里有 errors:list（漏了打包自检会报 channelsMissing）', () => {
    expect(channels).toContain("'errors:list'")
    expect(preload).toContain('errorsList:')
  })

  it('面板不在组件里写死语义色（颜色只有 statusLanguage 那一份）', () => {
    expect(panel).not.toMatch(/var\(--(danger|warning|success)\)/)
    expect(panel).toContain('STATUS_CLASS')
  })
})
