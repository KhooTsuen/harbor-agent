import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_ACTIONS, TOOL_LABELS, toolLabel } from '../agentActivity'
import { isActivePhase } from '../agentPhase'
import { summarizeArgs } from '../../stores/thread/parseToolOutput'

/* ══════════════════════════════════════════════════════════════
   已知问题清扫（AG-011）

   这一批不是新功能，是把几个「记在 CHANGELOG 里但一直没动」的小洞补上：

     · 工具摘要带着 `chcp 65001 >nul &&` 这层壳（模型为中文不乱码自己加的）
     · 文件路径太长不截断，把整块界面撑开
     · 时间线的动作行显示 `list_dir` 这种原名，等于没显示
     · 顶栏的活动文字按断点隐藏，窄窗口完全看不到在干什么
     · 跑着的时候写了新消息，没有任何地方说「得先停」

   前三项是**纯函数**，直接跑；后两项是 JSX，只能做源码守卫 ——
   和 AG-009 的做法一致：防的是半年后有人顺手改回去。
   ══════════════════════════════════════════════════════════════ */

const SRC = join(__dirname, '..', '..')
const ROOT = join(SRC, '..')

describe('工具参数摘要', () => {
  it('把命令开头的 chcp 壳剥掉', () => {
    expect(summarizeArgs('run_shell', { command: 'chcp 65001 >nul && ping -n 8 127.0.0.1' })).toBe(
      'ping -n 8 127.0.0.1',
    )
  })

  it('单 & 的壳也剥（cmd 两种写法都有人写）', () => {
    expect(summarizeArgs('run_shell', { command: 'chcp 65001 >nul & dir' })).toBe('dir')
  })

  it('本来就没壳的命令原样放着', () => {
    expect(summarizeArgs('run_shell', { command: 'npm test' })).toBe('npm test')
  })

  it('★ 只剥开头那一个 —— 命令中间出现的 chcp 不许动', () => {
    const cmd = 'echo hi && chcp 65001 >nul && ping x'
    expect(summarizeArgs('run_shell', { command: cmd })).toBe(cmd)
  })

  it('命令超长仍然截断', () => {
    const out = summarizeArgs('run_shell', { command: 'x'.repeat(300) })
    expect(out.length).toBe(100)
  })

  it('长路径掐中间，头尾都留着', () => {
    const p = `E:/${'a'.repeat(120)}/main.ts`
    const out = summarizeArgs('read_file', { path: p })
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out).toContain('…')
    expect(out.startsWith('E:/')).toBe(true)
    expect(out.endsWith('main.ts')).toBe(true)
  })

  it('短路径不动它', () => {
    expect(summarizeArgs('read_file', { path: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('list_dir 没有路径时退化成当前目录', () => {
    expect(summarizeArgs('list_dir', { path: '' })).toBe('.')
  })
})

describe('工具名转人话', () => {
  it('认识的转成人话', () => {
    expect(toolLabel('list_dir')).toBe('查看目录')
    expect(toolLabel('run_shell')).toBe('运行命令')
    expect(toolLabel('browse_click')).toBe('点击页面元素')
  })

  it('没收录的老实返回原名（不编）', () => {
    expect(toolLabel('some_future_tool')).toBe('some_future_tool')
  })

  it('★ 内核里注册过的工具，人话表里都得有 —— 防新增工具时漏掉', () => {
    const dir = join(ROOT, 'electron', 'core', 'tools')
    const names = readdirSync(dir)
      .filter((f) => f.endsWith('.cjs') && f !== 'index.cjs')
      .flatMap((f) => {
        const src = readFileSync(join(dir, f), 'utf8')
        return [...src.matchAll(/^\s{2}name: '([a-z_]+)',$/gm)].map((m) => m[1])
      })

    expect(names.length).toBeGreaterThan(5)
    const missing = names.filter((n) => !(n in TOOL_LABELS))
    expect(missing).toEqual([])
  })

  it('★ 人话表和动作词表覆盖同一批工具（两张表不许各漏一半）', () => {
    const labels = Object.keys(TOOL_LABELS).sort()
    const actions = Object.keys(AGENT_ACTIONS).sort()
    expect(labels).toEqual(actions)
  })
})

describe('界面上的两处（源码守卫）', () => {
  it('顶栏活动文字不再按断点隐藏', () => {
    const src = readFileSync(join(SRC, 'components', 'layout', 'AppTitleBar.tsx'), 'utf8')
    /* 以前是 `hidden … md:flex` —— 窄窗口直接看不到「正在干什么」 */
    expect(src).not.toContain('text-fg-tertiary md:flex')
    /* 改成长度兜底：靠截断而不是靠藏 */
    expect(src).toContain('max-w-[38vw]')
  })

  it('跑着的时候写了新消息，可以排队发送（不再要求先停掉）', () => {
    /* AG-025：按钮区抽到了 composer/SendControls.tsx */
    const src = readFileSync(
      join(SRC, 'components', 'chat', 'composer', 'SendControls.tsx'),
      'utf8',
    )
    expect(src).toContain('hasContent')
    expect(src).toContain('排队发送')
    expect(src).toContain('加入队列')
  })
})

describe('暂停之后的界面状态（AG-011）', () => {
  it('★ paused 不算「正在干活」—— 否则暂停后按钮不消失', () => {
    expect(isActivePhase('paused')).toBe(false)
  })

  it('干活的阶段仍然算', () => {
    expect(isActivePhase('executing')).toBe(true)
    expect(isActivePhase('thinking')).toBe(true)
    expect(isActivePhase('preparing')).toBe(true)
  })

  it('★ 等用户确认（waiting_user）仍算 —— 请求还活着，按钮得留着', () => {
    expect(isActivePhase('waiting_user')).toBe(true)
  })

  it('终态和空闲都不算', () => {
    expect(isActivePhase('completed')).toBe(false)
    expect(isActivePhase('cancelled')).toBe(false)
    expect(isActivePhase('idle')).toBe(false)
    expect(isActivePhase(undefined)).toBe(false)
  })
})

describe('任务事后看得见（AG-005 / AG-009 遗留）', () => {
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

  it('右栏「状态」里挂了任务列表', () => {
    expect(read('components/chat/StatePanel.tsx')).toContain('<TaskList />')
  })

  it('★ 没有对话状态时，任务列表仍然显示', () => {
    /* 以前是 `if (!state) return <p>…</p>` —— 连任务一起被挡掉了 */
    expect(read('components/chat/StatePanel.tsx')).not.toMatch(/if \(!state\)\s*return/)
  })

  it('点开一条任务能看到它的时间线', () => {
    expect(read('components/chat/TaskList.tsx')).toContain('ProgressTimeline')
  })

  it('任务列表只读 —— 改状态（继续/放弃）只在右栏任务中心', () => {
    expect(read('components/chat/TaskList.tsx')).not.toContain('taskUpdate')
  })

  it('★ 对话顶部横幅已撤掉，能力全在任务中心（用户反馈「打开应用先看到黄条很迷茫」）', () => {
    expect(existsSync(join(ROOT, 'src/components/chat/TaskBanner.tsx'))).toBe(false)
    expect(read('App.tsx')).not.toContain('TaskBanner')
    const row = read('components/chat/TaskRow.tsx')
    expect(row).toContain('继续')
    expect(row).toContain('放弃')
    /* 动作真的接上了：继续 → resumeTask，放弃 → taskUpdate */
    expect(read('components/chat/TaskCenter.tsx')).toContain('resumeTask(task.id)')
    expect(read('components/chat/TaskCenter.tsx')).toContain('taskUpdate(task.id')
  })
})
