import { Button } from '@/components/ui/Button'

/* ══════════════════════════════════════════════════════════════
   开屏「动作层」：三个动态主动作（设计文档 §6.3 / §16）

   硬规矩：**点击只把结构化提示填进输入框，让用户确认** ——
   只有明确无风险的界面操作（选择工作区）可以立即执行。
   动作随工作区状态变化：没 Git 不显示「检查变更」、没测试入口
   换成「查找运行方式」；空白工作区给「选择工作区 / 创建说明文件」。
   ══════════════════════════════════════════════════════════════ */

export interface LaunchAction {
  id: string
  label: string
  kind: 'fill' | 'pick-workdir'
  /** kind='fill' 时：点击后填入输入框的话（可编辑，不直接执行） */
  fill?: string
}

export interface LaunchActionInput {
  /** 工作区扫描是否成功拿到目录 */
  hasDir: boolean
  isGitRepo: boolean
  gitHasChanges: boolean
  /** 检测到的测试跑法（'' = 没有测试入口） */
  testCommand: string
  /** 空白工作区：没有技术栈标志、不是仓库、没有测试入口 */
  emptyWorkspace: boolean
}

export function buildLaunchActions(input: LaunchActionInput): LaunchAction[] {
  if (!input.hasDir) {
    return [
      { id: 'pick', label: '选择工作区', kind: 'pick-workdir' },
      {
        id: 'readme',
        label: '创建说明文件',
        kind: 'fill',
        fill: '帮我为这个项目起一个 README：它是做什么的、怎么运行、有哪些注意事项。先给我看草稿，确认后再写文件。',
      },
    ]
  }
  if (input.emptyWorkspace) {
    return [
      { id: 'pick', label: '选择工作区', kind: 'pick-workdir' },
      {
        id: 'readme',
        label: '创建说明文件',
        kind: 'fill',
        fill: '这个目录还是空的。先聊一下我想让它变成什么，再决定建哪些文件。',
      },
    ]
  }
  const actions: LaunchAction[] = []
  if (input.isGitRepo && input.gitHasChanges) {
    actions.push({
      id: 'diff',
      label: '检查当前变更',
      kind: 'fill',
      fill: '先过一遍当前未提交的改动：按风险排个序，说明每处改了什么。先别改文件。',
    })
  }
  if (input.testCommand) {
    actions.push({
      id: 'test',
      label: '运行测试',
      kind: 'fill',
      fill: `在当前工作区运行测试（${input.testCommand}），跑完把失败项和原因列出来。`,
    })
  } else {
    actions.push({
      id: 'test-how',
      label: '查找运行方式',
      kind: 'fill',
      fill: '读一遍项目配置（package.json / 构建脚本），告诉我怎么构建、怎么运行、怎么测试。先别执行写操作。',
    })
  }
  actions.push({
    id: 'understand',
    label: '理解项目结构',
    kind: 'fill',
    fill: '先只读地过一遍这个项目：整体结构、关键模块、建议从哪儿开始看。不要修改任何文件。',
  })
  return actions.slice(0, 3)
}

export function LaunchActions({
  input,
  onFill,
  onPickWorkdir,
}: {
  input: LaunchActionInput
  onFill: (text: string) => void
  onPickWorkdir: () => void
}) {
  const actions = buildLaunchActions(input)
  return (
    <div className="flex max-w-xl flex-wrap justify-center gap-2">
      {actions.map((action) => (
        <Button
          key={action.id}
          variant="secondary"
          size="sm"
          onClick={() => {
            if (action.kind === 'pick-workdir') onPickWorkdir()
            else if (action.fill) onFill(action.fill)
          }}
        >
          {action.label}
        </Button>
      ))}
    </div>
  )
}
