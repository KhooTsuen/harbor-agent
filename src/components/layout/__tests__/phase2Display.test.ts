import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TABS } from '@/components/layout/RightTabs'
import { useRightTabBadges } from '@/hooks/useRightTabBadges'

/* ══════════════════════════════════════════════════════════════
   Phase 2 · 右栏信息层级接线守卫

   和 phase1Display.test.ts 同一路子：真机截图证明「看得见」，
   这里证明**接对了**（标签顺序、两类点的形状分离、数据同源、
   互指文案落在内容区而不是标签栏）。少一处就是「点了没反应」或
   「角标把『有成果』看成『出错了』」这类不报错的问题。
   ══════════════════════════════════════════════════════════════ */

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

describe('Phase 2 · C 标签分组（高频前置，一个不少）', () => {
  it('★ 八个标签全在，且高频（审查·文件·任务·成果）排在前', () => {
    expect(TABS.map((t) => t.id)).toEqual([
      'diff',
      'files',
      'tasks',
      'artifacts',
      'browser',
      'downloads',
      'state',
      'errors',
    ])
    /* 分组本身也就是顺序 —— 第一组必须整体在前 */
    expect(TABS.filter((t) => t.group === 1).map((t) => t.id)).toEqual([
      'diff',
      'files',
      'tasks',
      'artifacts',
    ])
    expect(TABS.filter((t) => t.group === 2).map((t) => t.id)).toEqual([
      'browser',
      'downloads',
      'state',
      'errors',
    ])
  })

  it('两组之间有一条发丝分隔线（纯装饰，标签仍可点）', () => {
    const tabs = read('src/components/layout/RightTabs.tsx')
    expect(tabs).toContain('h-4 w-px')
  })

  it('★ 不删功能：面板挂载点一个不减', () => {
    const panel = read('src/components/layout/RightPanel.tsx')
    for (const tab of ['diff', 'files', 'artifacts', 'tasks', 'downloads', 'state', 'errors']) {
      expect(panel, tab).toContain(`activeRightTab === '${tab}'`)
    }
    /* 浏览器不随标签卸载，单独一层 */
    expect(panel).toContain('<BrowserTab')
  })
})

describe('Phase 2 · 视觉语义分离：有内容 ≠ 未读错误', () => {
  const badge = strip(read('src/components/layout/TabBadge.tsx'))

  it('★ 「有内容」是空心环（border）、中性色；「未读」是实心圆（background）+ 状态色', () => {
    /* 空心：用 border 画，颜色中性（--text-tertiary），不是语义色 */
    expect(badge).toContain('borderColor')
    expect(badge).toContain('var(--text-tertiary)')
    /* 实心：用 background 画，颜色来自 statusLanguage */
    expect(badge).toContain("colorOf(worst === 'P0' ? 'failed' : 'warning')")
    /* 形状不同才算分离：有 border 的空心环 vs 无 border 的实心块 */
    expect(badge).toMatch(/border['"]/)
  })

  it('★ 三类「有内容」提示接上，但都不是错误色源', () => {
    const tabs = read('src/components/layout/RightTabs.tsx')
    expect(tabs).toContain('taskPending')
    expect(tabs).toContain('downloadsActive')
    expect(tabs).toContain('artifactPresent')
    /*
     * 「有内容」与「未读」互斥渲染：有未读时不叠一个空心环上去。
     * P3 #9 之后这条判据从「一个布尔 hasContent」升级成三态
     * （`activityOf` 返回 none / running / waiting / content，互斥天然成立），
     * 于是断言也跟着从「源码里写了这句短路」改成「三态只挑一个画」——
     * 意图一字未变：**同一个位置不可能既显示空心环又显示未读实心点**。
     */
    expect(tabs).toContain("activity === 'content' ? <ContentDot />")
    expect(tabs).toContain("activity === 'waiting' ? <UnreadDot")
    /* 三态两两互斥由 activityOf 保证（见 tabShelf 的单测） */
    expect(tabs).not.toContain('hasContent[')
  })
})

describe('Phase 2 · 角标数据同源、无轮询', () => {
  it('★ RightPanel 与 AppTitleBar 都用同一个 hook（不各算一套）', () => {
    expect(read('src/components/layout/RightPanel.tsx')).toContain('useRightTabBadges()')
    expect(read('src/components/layout/AppTitleBar.tsx')).toContain('useRightTabBadges()')
  })

  it('★ 角标 hook 没有定时器（不引入轮询）', () => {
    const hook = strip(read('src/hooks/useRightTabBadges.ts'))
    expect(hook).not.toMatch(/setInterval|setTimeout/)
    /* 只读订阅，不做任何 IPC 调用 */
    expect(hook).not.toMatch(/await |\.then\(/)
  })

  it('★ RightTabs 把三类角标透传下去', () => {
    const panel = read('src/components/layout/RightPanel.tsx')
    expect(panel).toContain('taskPending={badges.taskPending}')
    expect(panel).toContain('downloadsActive={badges.downloadsActive}')
    expect(panel).toContain('artifactPresent={badges.artifactPresent}')
  })

  it('hook 导出的形状与 TABS 的 id 一致（键名对得上）', () => {
    /* 类型层面已经保证；这里防「hook 返回值改名、调用方忘了跟着改」的漂移 */
    const src = read('src/hooks/useRightTabBadges.ts')
    for (const key of ['diffCount', 'errorUnread', 'errorWorst', 'runningTasks']) {
      expect(src, key).toContain(key)
    }
    expect(typeof useRightTabBadges).toBe('function')
  })
})

describe('Phase 2 · 顶栏兜底（右栏折叠也不丢工作状态）', () => {
  const bar = read('src/components/layout/AppTitleBar.tsx')

  it('★ 运行中任务数 + 未提交改动数都透传到顶栏', () => {
    expect(bar).toContain('runningTasks')
    expect(bar).toContain('个后台任务在运行')
    expect(bar).toContain('个文件未提交改动')
  })

  it('★ 兜底提示与错误点区分：运行中用「运行」状态色，不是错误色', () => {
    /* 错误点仍是 P0/P1 色；运行中用的是 colorOf('running') */
    expect(bar).toContain("colorOf('running')")
    expect(bar).toContain("colorOf(errorWorst === 'P0' ? 'failed' : 'warning')")
  })
})

describe('Phase 2 · 互指文案写在内容区，不塞标签栏', () => {
  it('★ 「审查」内容区说清它是工作区改动、正式产出去「成果」', () => {
    const panel = read('src/components/layout/RightPanel.tsx')
    expect(panel).toContain('工作区里被改动的文件')
    expect(panel).toContain('正式产出（artifact）在「成果」')
  })

  it('★ 标签栏里不出现互指长文案（它只该有标签名）', () => {
    const tabs = strip(read('src/components/layout/RightTabs.tsx'))
    expect(tabs).not.toContain('正式产出')
    expect(tabs).not.toContain('工作区里被改动')
  })

  it('「成果」面板已有去「审查」的入口（Phase 1 起，本阶段不退化）', () => {
    const art = read('src/components/chat/ArtifactsPanel.tsx')
    expect(art).toContain("setActiveRightTab('diff')")
  })
})
