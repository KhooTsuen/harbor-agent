import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   Phase 1 · 展示层接线守卫

   这一组守的是**测试照不到的那一层**（和 errorsPanel.test.ts 同一路子）：
   真机截图能证明「看得见」，这里证明「接对了」——组件表、store 订阅、
   数据源只有一处、措辞不回流成内部字段。少一处就是「点了没反应」
   「角标永远不亮」这类不报错的问题。
   ══════════════════════════════════════════════════════════════ */

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
/** 读源码先剥注释 —— 注释里提一句关键词不算接线 */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

describe('Phase 1 · A1 错误标签未读角标', () => {
  const tabs = read('src/components/layout/RightTabs.tsx')

  it('标签表接上了 errorUnread，角标颜色走 statusLanguage（不写死语义色）', () => {
    expect(tabs).toContain('errorUnread')
    /*
     * Phase 2 把「两种点」的形状 / 颜色定义搬到了 `TabBadge.tsx`（那里是唯一真相源），
     * 所以这里改钉「RightTabs 确实用了那个组件」+「未读点的颜色表达式仍在」——
     * 断言强度不变，只是跟着代码走。
     */
    expect(tabs).toContain('UnreadDot')
    /* 组件里不许出现 var(--danger) 一类 —— 有 statusLanguage.test 另外盯着，这里也钉一下 */
    expect(tabs).not.toMatch(/var\(--(danger|warning|success)\)/)
  })

  it('★ 未读点颜色唯一来源 + 与「有内容」点形状不同（Phase 2 强化）', () => {
    const badge = read('src/components/layout/TabBadge.tsx')
    expect(badge).toContain("colorOf(worst === 'P0' ? 'failed' : 'warning')")
    expect(badge).not.toMatch(/var\(--(danger|warning|success)\)/)
    /* 「有内容」是空心环（border）／「未读」是实心圆（background）—— 形状必须不同 */
    expect(badge).toContain('border')
  })
})

describe('Phase 1 · A2 右栏折叠/窄窗仍能发现严重错误', () => {
  const bar = read('src/components/layout/AppTitleBar.tsx')

  it('顶栏那个「切换右侧面板」按钮带上同一个信号', () => {
    /* Phase 2：信号改由**共用 hook** 提供（右栏角标与顶栏兜底同一份），仍是同一个错误信号 */
    expect(bar).toContain('useRightTabBadges')
    expect(bar).toContain('errorUnread')
  })
})

describe('Phase 1 · A1 数据源只有一处 + 打开只清「未读」', () => {
  it('RightPanel 订阅同一个 store，并在打开「错误」标签时 acknowledge', () => {
    const panel = read('src/components/layout/RightPanel.tsx')
    expect(panel).toContain('useErrorsStore')
    expect(panel).toContain("if (tab === 'errors') useErrorsStore.getState().acknowledge()")
  })

  it('★ 打开面板只清「未读」、不声称已处理（面板里写清楚了）', () => {
    const errors = strip(read('src/components/layout/ErrorsPanel.tsx'))
    expect(errors).toContain('acknowledge()')
    expect(errors).toContain('未读')
    /* 抓取收到 store 了 —— 面板不再自己 listErrors（否则就是两套数据） */
    expect(errors).not.toContain('listErrors')
  })

  it('★ 角标触发**没有定时器**（不引入轮询）', () => {
    const hook = strip(read('src/hooks/useErrorSignal.ts'))
    expect(hook).not.toMatch(/setInterval|setTimeout/)
    expect(hook).toContain('visibilitychange')
  })
})

describe('Phase 1 · D 状态栏术语统一', () => {
  const bar = read('src/components/layout/StatusBar.tsx')

  it('★ 模式 / 推理读同一份中文常量，不再显示内核原值', () => {
    expect(bar).toContain('modeMeta(mode)')
    expect(bar).toContain('REASONING_LABEL')
    /* 不再直接渲染 {mode} / {thread?.reasoning} 的原始字段 */
    expect(bar).not.toMatch(/\{mode\}/)
    expect(bar).not.toMatch(/\{thread\?\.reasoning\}/)
  })
})

describe('Phase 1 · B1/B2 计划 vs 执行', () => {
  it('★ 三处计划进度共用一份措辞，且标明是「计划」', () => {
    const model = read('src/components/chat/taskCenterModel.ts')
    expect(model).toContain('计划 ${done}/${total} 步')
    expect(read('src/components/chat/TaskRow.tsx')).toContain('planProgressLabel')
    expect(read('src/components/chat/PlanCard.tsx')).toContain('planProgressLabel')
    expect(read('src/components/chat/launch/ResumeCard.tsx')).toContain('planProgressLabel')
  })

  it('时间线把「计划」那一段单独标出来（别读成执行进度）', () => {
    expect(read('src/components/chat/ProgressTimeline.tsx')).toContain('计划（模型给的 · 未执行）')
  })

  it('★ 全仓库没有任务百分比（没有可信分母就不显示百分比）', () => {
    const files = [
      'src/components/chat/TaskRow.tsx',
      'src/components/chat/PlanCard.tsx',
      'src/components/chat/TaskRowDetails.tsx',
      'src/components/chat/TaskConsole.tsx',
      'src/components/chat/launch/ResumeCard.tsx',
    ]
    for (const file of files) {
      expect(read(file), file).not.toMatch(/%/)
    }
  })
})

describe('Phase 1 · B3 成果与文件修改的关系', () => {
  const art = read('src/components/chat/ArtifactsPanel.tsx')

  it('空态说清「只放正式产出」，并给去「审查」的入口', () => {
    expect(art).toContain('正式产出')
    expect(art).toContain("setActiveRightTab('diff')")
  })

  it('★ 不把工作区改动冒充成正式成果（仍走 artifact 数据源）', () => {
    expect(art).toContain('artifactList()')
  })
})
