import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLaunchActions } from '@/components/chat/launch/LaunchActions'

/* ══════════════════════════════════════════════════════════════
   开屏接线钉子（设计文档 §16 / §20 / §23.10）

   UI 行为真正跑在真机上（探针另查）；这里钉**接线**：
   该出现的入口在、危险动作只填不跑、彩蛋只认真实证据。
   ══════════════════════════════════════════════════════════════ */

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

describe('开屏 / 动作层（纯函数）', () => {
  it('有 Git 变更 + 测试入口 → 检查变更 / 运行测试 / 理解结构', () => {
    const actions = buildLaunchActions({
      hasDir: true,
      isGitRepo: true,
      gitHasChanges: true,
      testCommand: 'npm test',
      emptyWorkspace: false,
    })
    expect(actions.map((a) => a.id)).toEqual(['diff', 'test', 'understand'])
    expect(actions.every((a) => a.kind === 'fill')).toBe(true)
  })

  it('没有测试入口 → 「运行测试」换成「查找运行方式」', () => {
    const actions = buildLaunchActions({
      hasDir: true,
      isGitRepo: false,
      gitHasChanges: false,
      testCommand: '',
      emptyWorkspace: false,
    })
    expect(actions.map((a) => a.id)).toEqual(['test-how', 'understand'])
  })

  it('空白工作区 → 选择工作区 + 创建说明文件（不是给一堆示例文案）', () => {
    const actions = buildLaunchActions({
      hasDir: true,
      isGitRepo: false,
      gitHasChanges: false,
      testCommand: '',
      emptyWorkspace: true,
    })
    expect(actions[0]).toMatchObject({ id: 'pick', kind: 'pick-workdir' })
    expect(actions.some((a) => a.id === 'readme' && a.kind === 'fill')).toBe(true)
  })

  it('没有目录 → 选择工作区在最前', () => {
    const actions = buildLaunchActions({
      hasDir: false,
      isGitRepo: false,
      gitHasChanges: false,
      testCommand: '',
      emptyWorkspace: false,
    })
    expect(actions[0].kind).toBe('pick-workdir')
  })
})

describe('开屏 / 接线钉子', () => {
  it('MessageList 的空状态就是 LaunchScreen（旧推荐问题不再出现在聊天列）', () => {
    const src = read('src/components/chat/MessageList.tsx')
    expect(src).toContain('<LaunchScreen />')
    expect(src).not.toContain('EMPTY_THREAD_PROMPTS')
  })

  it('LaunchScreen：等扫描收敛才抽欢迎语，且受 persona 开关控制', () => {
    const src = read('src/components/chat/launch/LaunchScreen.tsx')
    expect(src).toContain('scanLoading || !persona')
    expect(src).toContain('.draw(hasHistory, normal)')
  })

  it('恢复卡：继续 = 复用原任务；放弃 = 只改状态不回滚；查看 = 打开任务中心', () => {
    const src = read('src/components/chat/launch/ResumeCard.tsx')
    expect(src).toContain('resumeTask(task.id)')
    expect(src).toContain("setActiveRightTab('tasks')")
    expect(src).toContain("taskUpdate(task.id, { status: 'cancelled' })")
  })

  it('航道畅通：只认 kind=success + outcome.tests=passed（真实退出码）', () => {
    const src = read('src/components/layout/HarborEggs.tsx')
    expect(src).toContain("outcome.tests !== 'passed'")
    expect(src).toContain("payload.kind !== 'success'")
    expect(src).toContain('celebrateGreen()')
  })

  it('/harbor 是斜杠命令（输入框拦截，不发消息）', () => {
    const src = read('src/stores/thread/commands.ts')
    expect(src).toContain("raw === '/harbor'")
    expect(src).toContain('openHarborStats()')
  })

  it('品牌标连点接线：registerBrandClick + 解锁写进设置', () => {
    const src = read('src/components/layout/AppTitleBar.tsx')
    expect(src).toContain('registerBrandClick(brandClicks.current')
    expect(src).toContain("theme: goingNight ? 'night' : 'default'")
    expect(src).toContain('nightUnlocked: true')
  })

  it('外观页：夜航选项只在解锁后出现；欢迎语开关可关', () => {
    const src = read('src/components/settings/tabs/AppearanceTab.tsx')
    expect(src).toContain("settings.nightUnlocked ? [{ value: 'night'")
    expect(src).toContain('updateSettings({ persona: v })')
  })

  it('灯塔的光只来自真实状态；离线不参与动画（灯灭留轮廓）', () => {
    const src = read('src/components/chat/launch/Lighthouse.tsx')
    expect(src).toContain("state !== 'offline' && 'harbor-beam'")
    /* 语义色不自己写 —— 走状态语言表 */
    expect(src).toContain("awaiting: colorOf('waiting')")
    expect(src).toContain("import { colorOf } from '@/lib/statusLanguage'")
  })

  it('统计面板只读台账（task:list），没有别的数据源', () => {
    const src = read('src/components/dialogs/HarborStatsModal.tsx')
    expect(src).toContain('taskList({ limit: 200 })')
    expect(src).not.toContain('fetch(')
  })
})
