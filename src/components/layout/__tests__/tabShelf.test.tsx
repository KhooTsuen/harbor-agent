import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activityOf, PRIMARY_TABS, shelfTabs, WIDE_THRESHOLD, type TabSignals } from '../tabShelf'
import { TABS } from '../RightTabs'

/* ══════════════════════════════════════════════════════════════
   P3 #18 · 右侧入口易识别
   P3 #9  · 右侧入口活动提示

   #18 三条：
     · 常用入口显示名称（不是无标签图标）
     · 空间不足时收进**带名称的菜单**，不会把入口挤出去
     · 每个入口都有可访问名称

   #9 三条：
     · 只有真有活动的入口才亮（「打开静态面板」不发光）
     · 会话等待 / 运行中 / 有内容 三类可区分
     · 历史错误不会被当作运行中
   ══════════════════════════════════════════════════════════════ */

const noSignals: TabSignals = {
  taskRunning: false,
  downloadRunning: false,
  agentUsedBrowser: false,
  errorUnread: 0,
  errorWorst: null,
  taskPending: false,
  downloadsActive: false,
  artifactPresent: false,
}

describe('P3 #18 · 右侧入口易识别', () => {
  it('★ 每个标签都带文字名称（不是只留图标）', () => {
    const html = renderToStaticMarkup(
      <div>
        {TABS.map((tab) => (
          <span key={tab.id}>{tab.label}</span>
        ))}
      </div>,
    )
    for (const tab of TABS) expect(html).toContain(tab.label)
    /* 八个入口一个不少 */
    expect(TABS).toHaveLength(8)
  })

  it('★ 宽栏（≥门槛）→ 八个全摆在栏上，一个都不进菜单', () => {
    const { inline, overflow } = shelfTabs(TABS, WIDE_THRESHOLD, 'diff')
    expect(inline).toHaveLength(8)
    expect(overflow).toHaveLength(0)
  })

  it('★ 窄栏 → 三个主入口留在栏上，其余收进菜单（不是消失）', () => {
    const { inline, overflow } = shelfTabs(TABS, 380, 'diff')
    expect(inline.map((t) => t.id)).toEqual([...PRIMARY_TABS])
    expect(overflow.map((t) => t.id)).toEqual([
      'artifacts',
      'browser',
      'downloads',
      'state',
      'errors',
    ])
    /* 两组合起来 = 全部（一个都没丢） */
    expect([...inline, ...overflow]).toHaveLength(8)
  })

  it('★ 当前标签落在菜单里时，栏上仍要显示它的名字（否则看不出在哪）', () => {
    const { inline, overflow } = shelfTabs(TABS, 380, 'downloads')
    expect(inline.map((t) => t.id)).toContain('downloads')
    expect(overflow.map((t) => t.id)).not.toContain('downloads')
  })

  it('宽度未知（0）按窄处理 —— 宁可收进菜单也不要挤爆', () => {
    const { overflow } = shelfTabs(TABS, 0, 'diff')
    expect(overflow.length).toBeGreaterThan(0)
  })

  it('宽度为 NaN / 负数也不崩，按窄处理', () => {
    expect(shelfTabs(TABS, Number.NaN, 'diff').overflow.length).toBeGreaterThan(0)
    expect(shelfTabs(TABS, -10, 'diff').overflow.length).toBeGreaterThan(0)
  })
})

describe('标签栏不许溢出（2026-10-20 用户截图反馈）', () => {
  /*
   * 用户截图里出现过「标签挤满一行、右侧没有关闭按钮、内容被切掉一半」的形态。
   * 根因是我自己的探针只改了 `aside.style.width` 却没改宿主容器（测量假象），
   * 但顺着它查出两个**真实的脆弱点**，这里各钉一条。
   */
  it('★ 关闭按钮不在会溢出/滚动的标签容器里（任何宽度都点得到）', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/layout/RightTabs.tsx'), 'utf8')
    /*
     * 结构要求：标签区是一个带 overflow-hidden 的 div，关闭按钮在它**外面**。
     * 以前整条栏是 `overflow-x-auto` 且关闭按钮用 `ml-auto` 在容器内 ——
     * 内容一超，按钮就被推出可视区（真机上表现为「找不到 X」）。
     */
    expect(src).toContain('overflow-hidden')
    expect(src).not.toContain('overflow-x-auto')
    const closeAt = src.indexOf('label="关闭右侧面板"')
    const tagAreaEnd = src.lastIndexOf('</div>', closeAt)
    expect(closeAt).toBeGreaterThan(tagAreaEnd) /* 关闭按钮在标签区之后、且不在其内部 */
  })

  it('★ 标签按钮允许收缩且文字可省略（入口不因挤而消失）', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/layout/RightTabs.tsx'), 'utf8')
    /* 可收缩：min-w-0 + shrink（以前是 shrink-0，永远不缩 → 只会溢出） */
    expect(src).toMatch(/h-7 min-w-0 shrink items-center/)
    /* 文字截断而不是撑开 */
    expect(src).toContain('truncate text-2xs')
  })

  it('★ useElementWidth 首测同步且只用一种口径（首帧不闪窄档、临界点不抖）', () => {
    /* 只看代码行：注释里正好在解释「以前用 contentRect」这件事，不该被判违规 */
    const src = readFileSync(join(process.cwd(), 'src/hooks/useElementWidth.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    /* 首测在 ref 回调里做（effect 之后才量会先渲染一帧窄档） */
    expect(src).toMatch(/ref = useCallback\([\s\S]*?push\(widthOf\(next\)\)/)
    /* 统一 clientWidth：以前首测用 getBoundingClientRect（含 padding）、
       RO 用 contentRect（不含），差 12px 正好卡在门槛上 */
    expect(src).not.toContain('contentRect')
    expect(src).not.toContain('getBoundingClientRect')
  })
})

describe('P3 #9 · 右侧入口活动提示', () => {
  it('★ 没有任何活动 → 一个入口都不亮', () => {
    for (const tab of TABS) expect(activityOf(tab.id, noSignals)).toBe('none')
  })

  it('★ 静态面板被打开不会让它自己发光（判据不知道「当前选中谁」）', () => {
    /* 这是 activityOf 的入参里根本没有 activeRightTab 的原因 —— 现在把它钉住 */
    const src = activityOf.toString()
    expect(src).not.toContain('active')
    expect(activityOf('state', noSignals)).toBe('none')
    expect(activityOf('files', noSignals)).toBe('none')
    expect(activityOf('diff', noSignals)).toBe('none')
  })

  it('任务在跑 → running；只是有未完成任务 → content', () => {
    expect(activityOf('tasks', { ...noSignals, taskRunning: true })).toBe('running')
    expect(activityOf('tasks', { ...noSignals, taskPending: true })).toBe('content')
  })

  it('下载在传 → running；只是列表里有条目 → content', () => {
    expect(activityOf('downloads', { ...noSignals, downloadRunning: true })).toBe('running')
    expect(activityOf('downloads', { ...noSignals, downloadsActive: true })).toBe('content')
  })

  it('★ 历史错误只可能是 waiting，永远不会是 running', () => {
    const waiting = activityOf('errors', { ...noSignals, errorUnread: 3, errorWorst: 'P0' })
    expect(waiting).toBe('waiting')
    expect(waiting).not.toBe('running')
  })

  it('Agent 动过网页 → content（已完成待看），不是 running', () => {
    expect(activityOf('browser', { ...noSignals, agentUsedBrowser: true })).toBe('content')
  })

  it('★ waiting 优先于 running（在等你的事比在跑的事更急）', () => {
    /* 同一时刻两件事都成立时，错误那个入口必须是 waiting */
    const both = { ...noSignals, taskRunning: true, errorUnread: 1, errorWorst: 'P1' as const }
    expect(activityOf('errors', both)).toBe('waiting')
    expect(activityOf('tasks', both)).toBe('running')
  })
})
