import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   第二阶段 · 设置项的归属（迁移后不许出现两个编辑入口）

   ── 为什么这组测试必须存在 ────────────────────────────────────
   第二阶段把三项从「通用与快捷键」搬到了别的页：

     · 默认模式      → 「对话与任务」
     · 自动起标题    → 「对话与任务」
     · 网页里的链接  → 「工具与扩展」

   搬家的风险不是「新地方没有」，而是**旧地方还留着** ——
   两个控件绑同一份配置，用户在 A 页改完到 B 页看还是旧值，
   然后开始怀疑设置没保存。这类 bug 不会让任何测试变红，只会让
   用户不敢改设置。

   所以判据是**双向**的：新页必须有，旧页必须没有。

   ── 为什么用读源码而不是渲染 ──────────────────────────────────
   「某页不该出现某个控件」这件事，渲染测试只能看到当前渲染出来的
   那一段；而源码断言覆盖整份文件，连条件分支里的残留也能抓到。
   渲染层的「能正常显示」由 `settingsPagesRender.test.tsx` 管。
   ══════════════════════════════════════════════════════════════ */

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
/** 剥掉注释：说明文字里常举坏例子，直接匹配会误伤（本项目踩过多次） */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const generalTab = strip(read('src/components/settings/tabs/GeneralTab.tsx'))
const behavior = strip(read('src/components/settings/panels/ConversationBehavior.tsx'))
const conversation = strip(read('src/components/settings/panels/ConversationPanel.tsx'))
const extension = strip(read('src/components/settings/panels/ExtensionPanel.tsx'))

describe('第二阶段 · 设置项归属（双向：新页有、旧页没有）', () => {
  it('★★ 默认模式在「对话与任务」，不在「通用与快捷键」', () => {
    expect(behavior).toContain('defaultMode')
    expect(generalTab).not.toContain('defaultMode')
    /* 并且「对话与任务」页真的把这块装进去了 */
    expect(conversation).toContain('ConversationBehavior')
  })

  it('★★ 自动起标题在「对话与任务」，不在「通用与快捷键」', () => {
    expect(behavior).toContain('autoTitle')
    expect(generalTab).not.toContain('autoTitle')
  })

  it('★★ 网页里的链接在「工具与扩展」，不在「通用与快捷键」', () => {
    expect(extension).toContain('browserNavigation')
    expect(generalTab).not.toContain('browserNavigation')
  })

  it('★ 回车发送留在「通用与快捷键」（它是输入习惯，属于应用本身）', () => {
    expect(generalTab).toContain('sendOnEnter')
    expect(behavior).not.toContain('sendOnEnter')
  })

  it('★ 窗口与托盘留在「通用与快捷键」', () => {
    expect(generalTab).toContain('minimizeToTray')
  })

  it('★ 迁移的配置键名没变（老用户存的值照旧生效）', () => {
    /* 搬家只动界面位置：键名写错的话，用户之前设的值会读不出来，
       表面上「设置丢了」，实际是读错了键。 */
    expect(behavior).toContain('patchGeneral({ autoTitle: v })')
    expect(extension).toContain("browserNavigation: v as 'ask' | 'allow' | 'block'")
  })
})

describe('第二阶段 · 7 个基础页都有自己的内容', () => {
  const pages: Array<[string, string, string[]]> = [
    ['个人资料', 'src/components/settings/tabs/ProfileTab.tsx', ['名字', '头像']],
    ['通用与快捷键', 'src/components/settings/tabs/GeneralTab.tsx', ['回车发送', 'ShortcutsTab']],
    ['外观与通知', 'src/components/settings/tabs/AppearanceTab.tsx', ['配色', '字号缩放', '通知']],
    [
      '对话与任务',
      'src/components/settings/panels/ConversationPanel.tsx',
      ['ConversationBehavior'],
    ],
    ['记忆', 'src/components/settings/tabs/MemoryTab.tsx', ['MemoryList', '写入策略']],
    [
      '经验与规则',
      'src/components/settings/tabs/ExperienceTab.tsx',
      ['ExperienceRow', 'LIFECYCLE'],
    ],
    ['关于 Harbor', 'src/components/settings/tabs/AboutTab.tsx', ['版本', '开源许可']],
  ]

  for (const [name, file, needles] of pages) {
    it(`★ ${name}：确实有实质内容（不是只换了标题的空白页）`, () => {
      const src = strip(read(file))
      for (const needle of needles) {
        expect(src, `${name} 缺「${needle}」`).toContain(needle)
      }
    })
  }
})

describe('第二阶段 · 通知只有一个编辑入口', () => {
  it('★★ 外观页只给「跳转」，不内嵌第二份逐类配置', () => {
    const appearance = strip(read('src/components/settings/tabs/AppearanceTab.tsx'))
    /* 有跳转按钮 */
    expect(appearance).toContain("setActiveRightTab('notifications')")
    /*
     * 不许自己渲染逐类路由编辑器 —— 那一份只在右栏「通知」标签里。
     * 判据：不出现直接写 notifyRoutes 的调用（跳转按钮不碰它）。
     */
    expect(appearance).not.toContain('notifyRoutes')
  })
})

describe('第二阶段 · 保存状态按需出现（不再常驻一句话）', () => {
  const page = strip(read('src/components/settings/SettingsPage.tsx'))

  it('★ idle 时不渲染任何保存提示', () => {
    /* 只剩 saving / failed / saved 三个分支 */
    expect(page).not.toContain('修改配置后自动保存')
  })

  it('★ 保存失败必须一直挂着（不能只闪一下）', () => {
    expect(page).toContain("state === 'failed'")
    expect(page).toContain('role="alert"')
  })

  it('★ 「已保存」自己会消失（否则会被当成按钮）', () => {
    expect(page).toContain('setTimeout')
    expect(page).toContain('savedVisible')
  })
})

describe('第二阶段 · 内容宽度由布局规则决定', () => {
  const page = strip(read('src/components/settings/SettingsPage.tsx'))

  it('★ 宽度常量集中在页框一处，各页不许自己写像素值', () => {
    expect(page).toContain('CONTENT_MAX')
    expect(page).toContain('CONTENT_WIDE')
  })

  it('★ 页框支持「宽一档」，不是所有页强制同一个窄列', () => {
    expect(page).toContain('wide')
  })
})
