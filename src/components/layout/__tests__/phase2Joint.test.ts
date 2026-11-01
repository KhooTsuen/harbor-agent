import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   第二阶段（顶栏 / 左栏 / 右栏 / 设置联合重构）接线守卫

   这一组钉的是「**行为**接上了」，不是「长得像」：
     · 左栏顶部那两个入口确实没了，而 Ctrl+N / 折叠态 / 三个入口还在
     · 右栏审查说清它是什么、跳过项与读取失败要单独显示
     · 文件树有手动刷新，且刷新读的是**当前这棵树**的目录
     · 两处「重置设置」走同一个实现
     · 设置里默认工作目录在「对话」页顶上

   真机能不能点、长得对不对，靠 `npm run shot:electron -- --dev` 截图，
   不靠这里（文件头写清，免得以后有人拿绿测当验收）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

describe('左栏 · 入口收敛，归属不变', () => {
  const header = strip(read('src/components/layout/sidebar/SidebarHeader.tsx'))

  it('★ 展开态顶部不再有「新建对话」和「默认工作目录」', () => {
    expect(header).not.toContain('新建对话')
    expect(header).not.toContain('默认工作目录')
    expect(header).not.toContain('chooseWorkdir')
  })

  it('★ Ctrl+N 与折叠态入口仍然走 createThread()（跟随当前选中的文件夹）', () => {
    const app = strip(read('src/App.tsx'))
    expect(app).toContain("matchCombo(event, shortcut('new-thread', 'mod+n'))")
    expect(app).toContain('createThread()')

    const collapsed = strip(read('src/components/layout/sidebar/CollapsedSidebar.tsx'))
    expect(collapsed).toContain('onCreateThread')
    const sidebar = strip(read('src/components/layout/Sidebar.tsx'))
    expect(sidebar).toContain('onCreateThread={() => createThread()}')
  })

  it('★ 三个说得清楚的入口都还在（选目录并新建 / 文件夹行＋ / 单独对话＋）', () => {
    const panes = strip(read('src/components/layout/sidebar/SidebarPanes.tsx'))
    /* 选目录并新建 */
    expect(panes).toContain('新建对话并指定目录')
    /* 文件夹行 ＋：归属 = 那个文件夹 */
    expect(panes).toContain('onNewThread={() => newThread(project.id)}')
    /* 单独对话 ＋：明确不挂目录 */
    expect(panes).toContain("newThread('')")
  })

  it('★ 空的「单独对话」区压小后：分隔线还在，并且有恢复高度的出口', () => {
    const panes = strip(read('src/components/layout/sidebar/SidebarPanes.tsx'))
    /* 空着时下限更小 */
    expect(panes).toContain('MIN_BOTTOM_EMPTY')
    /* 分隔线一直渲染（不因为空就摘掉） */
    expect(panes).toContain('调整文件夹与单独对话的分栏高度')
    /* 恢复高度 */
    expect(panes).toContain('恢复单独对话栏高度')
    expect(panes).toContain('sidebarFolderPercent: DEFAULT_PERCENT')
  })
})

describe('左栏 · 多选删除的范围一致性', () => {
  it('★ 多选列表收的是「可见范围」，不是全部对话', () => {
    const sidebar = strip(read('src/components/layout/Sidebar.tsx'))
    expect(sidebar).toContain('selectableThreads')
    expect(sidebar).toContain('threads={selectableThreads}')
    /* 旧写法（把全部对话塞进去）不许回来 */
    expect(sidebar).not.toContain('threads={threads}')
  })

  it('★ 可见范围一变就 restrictTo（不留看不见的待删项）', () => {
    const sidebar = strip(read('src/components/layout/Sidebar.tsx'))
    expect(sidebar).toContain('restrictTo(selectableThreads.map((t) => t.id))')
  })

  it('★ 删除文件夹的确认文案说明「含归档」和「任务记录」，并说明磁盘不动', () => {
    const folder = strip(read('src/components/layout/sidebar/FolderSection.tsx'))
    /* 数字数的是全部（含已归档） */
    expect(folder).toContain('allThreads.filter((t) => t.projectId === project.id)')
    expect(folder).toContain('任务记录会一起删掉')
    expect(folder).toContain('磁盘上那个目录')
  })
})

describe('右栏 · 审查 / 文件树 / 收起长条', () => {
  const diffPanel = strip(read('src/components/layout/panels/DiffPanel.tsx'))

  it('★ 审查说清归属（对话 / 状态 / 文件数），不再叫「未提交」', () => {
    expect(diffPanel).toContain('最近一批 Harbor 改动')
    expect(diffPanel).toContain('对话：')
    expect(diffPanel).toContain('状态：')
    expect(diffPanel).toContain('个文件')
    expect(diffPanel).not.toContain('未提交的改动')
  })

  it('★ 没有 diff 文件时，跳过项与读取失败仍然各自显示', () => {
    /* 空态分支里也要渲染 skipped / diffError */
    const empty = diffPanel.slice(diffPanel.indexOf('EmptyState'))
    expect(empty).toContain('SkippedNote')
    expect(empty).toContain('diffError')
  })

  it('★ 文件树有手动刷新，且读的是当前这棵树的目录', () => {
    const tree = strip(read('src/components/layout/FileTree.tsx'))
    expect(tree).toContain('刷新文件树')
    expect(tree).toContain('onRefresh')

    const panel = strip(read('src/components/layout/RightPanel.tsx'))
    expect(panel).toContain('onRefresh={() =>')
    expect(panel).toContain('readTree(effectiveProject?.path')
  })

  it('★ 收起后的展开按钮整条可点，展开后不渲染', () => {
    const host = strip(read('src/components/layout/RightPanelHost.tsx'))
    expect(host).toContain('aria-label="展开右侧面板"')
    /* 整条：有高度撑满 + 有宽度 */
    expect(host).toMatch(/w-2\.5.*items-center.*justify-center/s)
  })

  it('★ 成果提示点与面板默认范围一致（当前对话）', () => {
    const badges = strip(read('src/hooks/useRightTabBadges.ts'))
    expect(badges).toContain('s.activeThreadId')
    /* 旧写法（扫全部对话）不许回来 */
    expect(badges).not.toContain('s.threads.some((t) => t.messages.some')
  })

  it('★ 点开「错误」只清未读（不声称已修复）', () => {
    const panel = strip(read('src/components/layout/RightPanel.tsx'))
    expect(panel).toContain('useErrorsStore.getState().acknowledge()')
  })
})

describe('设置 · 工作目录与两处重置', () => {
  it('★ 默认工作目录在「对话」页最上面，并标明是全局默认', () => {
    const conv = strip(read('src/components/settings/panels/ConversationPanel.tsx'))
    expect(conv).toContain('<WorkdirRow />')
    expect(conv).toContain('全局默认')
    /* 而且在体验页之前（顶部） */
    expect(conv.indexOf('<WorkdirRow />')).toBeLessThan(
      conv.indexOf('ConversationExperienceTab />'),
    )
  })

  it('★ 「工具」页不再有工作目录（不出现两处真源）', () => {
    const providers = strip(read('src/components/settings/ProviderPanel.tsx'))
    expect(providers).not.toContain('WorkdirRow')
  })

  it('★ 两处重置走同一个实现', () => {
    const modal = strip(read('src/components/settings/SettingsModal.tsx'))
    const data = strip(read('src/components/settings/tabs/DataTab.tsx'))
    expect(modal).toContain('resetAllSettings()')
    expect(data).toContain('resetAllSettings()')
    /* 旧的「先本地重置、再看全局保存状态猜成败」不许回来 */
    expect(data).not.toContain('resetToDefaults()')
    expect(data).not.toContain('useConfigSaveStatus.getState().state')
  })

  it('★ 两处都叫「重置设置」（同一个名字、同一个范围）', () => {
    const modal = strip(read('src/components/settings/SettingsModal.tsx'))
    const data = strip(read('src/components/settings/tabs/DataTab.tsx'))
    expect(modal).toContain('重置设置')
    expect(data).toContain('重置设置')
    /* 弹窗底部不再叫「恢复默认」（那是工作目录那一项自己的按钮名） */
    expect(modal).not.toContain("'恢复默认'")
  })

  it('★ 工作目录三路保存都会回报结果（手填 / 选目录 / 恢复默认）', () => {
    const row = strip(read('src/components/settings/providers/WorkdirRow.tsx'))
    /* 手填与恢复默认走同一个 save()，失败要回显 */
    expect(row).toContain('async function save(')
    expect(row).toContain('保存失败')
    /* 选目录 */
    expect(row).toContain('chooseWorkdir')
    /* 存完要回主进程重读生效目录 */
    expect(row).toContain('syncWorkdir()')
  })

  /*
   * ★ 这一条是**真机逮到的**（2026-10-31 验收 T7）：重启后主进程返回的生效目录
   *   是对的，设置页却还显示「data/chat（默认）」—— 因为启动引导只把目录写进
   *   appStore（会话列表 / 文件树用的那份），设置页读的 configStore 一直是空的。
   *   两份存的是同一个值，启动时必须一起填；否则「重启后显示值与生效值一致」这条做不到。
   */
  it('★ 启动引导把生效目录同时写进两份（appStore + configStore）', () => {
    const boot = strip(read('src/hooks/useAppBootstrap.ts'))
    expect(boot).toContain('useAppStore.setState({ workdir })')
    expect(boot).toContain('useConfigStore.setState({ workdir })')
  })

  it('★ 配置里的目录不存在而回落到默认时，界面要说明（不悄悄换一个）', () => {
    const row = strip(read('src/components/settings/providers/WorkdirRow.tsx'))
    expect(row).toContain('configured !== workdir')
    expect(row).toContain('已回落到')
  })
})
