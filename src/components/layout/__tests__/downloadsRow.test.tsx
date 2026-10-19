import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DownloadsRow } from '../downloadsRow'
import type { DownloadItem } from '@/lib/downloadsApi'

/* ══════════════════════════════════════════════════════════════
   P3 #28 · 下载状态与操作

   三条验收，逐条钉：
     ① 总大小未知时不显示虚假百分比（以前画成 100% 满格）
     ② 「移除记录」与磁盘文件分开命名 —— 文案必须说清文件还在
     ③ 完成的行给出落盘路径与「在文件夹中显示」入口
   ══════════════════════════════════════════════════════════════ */

const base: DownloadItem = {
  id: 'd1',
  url: 'https://example.com/a.bin',
  file: 'E:\\CodexWorkbench\\data\\workspace\\a.bin',
  name: 'a.bin',
  total: 2048,
  received: 1024,
  status: 'running',
  origin: 'user',
  error: '',
  createdAt: 1,
  updatedAt: 2,
  finishedAt: 0,
  connections: 4,
  attempts: 1,
  speedBps: 1024,
}

const render = (item: DownloadItem): string =>
  renderToStaticMarkup(<DownloadsRow item={item} onAct={() => {}} />)

describe('P3 #28 · 下载状态与操作', () => {
  it('总大小已知 → 真实百分比，进度条按百分比定宽', () => {
    const html = render(base)
    expect(html).toContain('50%')
    expect(html).toContain('width:50%')
    expect(html).toContain('aria-valuenow="50"')
  })

  it('★ 总大小未知（total=0）→ 不出现虚假百分比，画不定态短条', () => {
    const html = render({ ...base, total: 0, received: 123456 })
    /* 关键判据：没有 `width:100%`（旧行为的满格），也没有百分比文案 */
    expect(html).not.toContain('width:100%')
    expect(html).not.toContain('aria-valuenow')
    expect(html).toContain('总大小未知')
    expect(html).toContain('已收')
    /* 不定态：固定 1/3 宽的短条 */
    expect(html).toContain('w-1/3')
  })

  it('★ 移除记录的文案说清「不删除已下载的文件」', () => {
    const html = render({ ...base, status: 'done' })
    expect(html).toContain('移除记录（不删除已下载的文件）')
    /* 不能再出现孤零零的「删除」按钮名 —— 那会被读成删文件 */
    expect(html).not.toContain('aria-label="删除"')
  })

  it('完成的下载露出落盘路径，并有「在文件夹中显示」', () => {
    const html = render({ ...base, status: 'done' })
    expect(html).toContain('a.bin')
    expect(html).toContain('在文件夹中显示')
    expect(html).toContain('data\\workspace')
  })

  it('失败的行保留错误原文，且可重试', () => {
    const html = render({ ...base, status: 'failed', error: '连接被重置' })
    expect(html).toContain('连接被重置')
    expect(html).toContain('重试')
  })
})
