import type { Message, Project, Thread } from '@/types'
import { uid } from '@/lib/utils'
import { diffFixNullGuard } from './snippets'
import { codeTests } from './content'

/* ══════════════════════════════════════════════════════════════
   浏览器 UI 预览的初始数据

   刻意造得「像真的在用」：两个项目、三条线程、状态各不相同，
   其中一条带历史和 diff，打开就能看到审查面板有内容。
   ══════════════════════════════════════════════════════════════ */

const now = Date.now()
const MINUTE = 60_000

export const DEFAULT_PROJECTS: Project[] = [
  {
    id: 'proj-workbench',
    name: 'personal-agent',
    description: '个人 Agent 工作台前端',
    path: '~/projects/personal-agent',
    branch: 'main',
    icon: '',
    color: '',
    pinned: false,
    archived: false,
    createdAt: now - 6 * 24 * 60 * MINUTE,
    updatedAt: now - 2 * MINUTE,
  },
  {
    id: 'proj-api',
    name: 'api-gateway',
    description: '网关服务，Go 写的',
    path: '~/projects/api-gateway',
    branch: 'feat/rate-limit',
    icon: '',
    color: '',
    pinned: false,
    archived: false,
    createdAt: now - 21 * 24 * 60 * MINUTE,
    updatedAt: now - 3 * 60 * MINUTE,
  },
]

/* ── 有历史的那条线程 ─────────────────────────────────────── */

const THREAD_ID = 'thread-parser'

function seedMessages(): Message[] {
  const diff = diffFixNullGuard()
  const tests = codeTests()

  return [
    {
      id: uid('msg'),
      threadId: THREAD_ID,
      role: 'user',
      content: 'parseConfig 遇到配置文件里的注释行会崩，帮我看看',
      kind: 'text',
      status: 'sent',
      timestamp: now - 9 * MINUTE,
    },
    {
      id: uid('msg'),
      threadId: THREAD_ID,
      role: 'assistant',
      content: `找到原因了：原代码假设每行都是 \`key=value\`，空行和注释行 split 之后只剩一个元素，解构出的 \`v\` 是 \`undefined\`，后面又拿它去做字符串操作就炸了。

改法是把空行和 \`#\` 开头的行跳过，顺手 trim 一下。`,
      kind: 'diff',
      status: 'sent',
      timestamp: now - 8 * MINUTE,
      diffs: [diff],
    },
    {
      id: uid('msg'),
      threadId: THREAD_ID,
      role: 'user',
      content: '再补几个边界测试',
      kind: 'text',
      status: 'sent',
      timestamp: now - 3 * MINUTE,
    },
    {
      id: uid('msg'),
      threadId: THREAD_ID,
      role: 'assistant',
      content: '补了三个，重点是**未来时间**那条——时间戳来自别的机器时最容易踩。',
      kind: 'code',
      status: 'sent',
      timestamp: now - 2 * MINUTE,
      codeBlocks: [tests],
    },
  ]
}

/* ── Markdown 渲染自检 ─────────────────────────────────────
   刻意把支持的语法全摆一遍。改渲染层之后打开这条会话看一眼，
   比翻单测快 —— 单测保证「结构对」，这条保证「看着对」。
   ────────────────────────────────────────────────────────── */

const SHOWCASE = [
  '# Markdown 渲染自检',
  '',
  '这一段确认**粗体**、*斜体*、~~删除线~~、`行内代码` 和 [链接](https://example.com) 都对。',
  '',
  '## 列表',
  '',
  '- 无序第一项',
  '  - 嵌套子项甲',
  '  - 嵌套子项乙',
  '- 无序第二项',
  '',
  '1. 有序第一项',
  '2. 有序第二项',
  '',
  '### 任务列表',
  '',
  '- [x] 表格',
  '- [x] 任务列表',
  '- [ ] 图片',
  '',
  '## 表格',
  '',
  '| 语法 | 支持 | 说明 |',
  '|:---|:---:|:---:|',
  '| 表格 | 是 | 冒号控制对齐 |',
  '| 嵌套列表 | 是 | 缩进子项 |',
  '| 行强调 | 是 | 看下面的代码块 |',
  '',
  '> 引用里还能放列表和代码块：',
  '>',
  '> - 甲',
  '> - 乙',
  '',
  '## 代码块',
  '',
  '```go title="main.go" {2}',
  'func main() {',
  '    fmt.Println("带文件名和行强调")',
  '}',
  '```',
  '',
  '```diff',
  '-旧的一行',
  '+新的一行',
  '```',
  '',
  '---',
  '',
  '最后一段，验证分隔线。',
].join('\n')

export const DEFAULT_THREADS: Thread[] = [
  {
    id: 'thread-showcase',
    projectId: 'proj-workbench',
    title: 'Markdown 渲染自检',
    messages: [
      {
        id: uid('msg'),
        threadId: 'thread-showcase',
        role: 'user',
        content: '把支持的各种 Markdown 语法摆一遍看看',
        kind: 'text',
        status: 'sent',
        timestamp: now - 40 * MINUTE,
      },
      {
        id: uid('msg'),
        threadId: 'thread-showcase',
        role: 'assistant',
        content: SHOWCASE,
        kind: 'text',
        status: 'sent',
        timestamp: now - 39 * MINUTE,
      },
    ],
    status: 'success',
    mode: 'pair',
    model: 'demo-standard',
    reasoning: 'medium',
    pinned: true,
    archived: false,
    tags: ['ui'],
    exportedAt: 0,
    createdAt: now - 40 * MINUTE,
    updatedAt: now - 39 * MINUTE,
  },
  {
    id: THREAD_ID,
    projectId: 'proj-workbench',
    title: '修复 parseConfig 崩在注释行',
    messages: seedMessages(),
    status: 'success',
    mode: 'pair',
    model: 'demo-standard',
    reasoning: 'medium',
    pinned: true,
    archived: false,
    tags: ['bug'],
    exportedAt: 0,
    createdAt: now - 12 * MINUTE,
    updatedAt: now - 2 * MINUTE,
  },
  {
    id: 'thread-sidebar',
    projectId: 'proj-workbench',
    title: '重构侧边栏的折叠逻辑',
    messages: [
      {
        id: uid('msg'),
        threadId: 'thread-sidebar',
        role: 'user',
        content: '侧边栏折叠后宽度会闪一下，帮我看看',
        kind: 'text',
        status: 'sent',
        timestamp: now - 4 * 60 * MINUTE,
      },
      {
        id: uid('msg'),
        threadId: 'thread-sidebar',
        role: 'assistant',
        content:
          '是 transition 作用在 width 上导致的。折叠态改成固定 48px 而不是 0，并让 transition 只作用在 width 的数值上，就不会闪了。\n\n我先把改动落到 sidebar 组件，你看下 diff。',
        kind: 'text',
        status: 'streaming',
        timestamp: now - 60 * MINUTE,
      },
    ],
    status: 'running',
    mode: 'execute',
    model: 'demo-standard',
    reasoning: 'low',
    pinned: false,
    archived: false,
    tags: ['refactor'],
    exportedAt: 0,
    createdAt: now - 5 * 60 * MINUTE,
    updatedAt: now - 40_000,
  },
  {
    id: 'thread-gateway',
    projectId: 'proj-api',
    title: '给网关加上限流',
    messages: [],
    status: 'idle',
    mode: 'plan',
    model: 'demo-reasoning',
    reasoning: 'high',
    pinned: false,
    archived: false,
    tags: ['feature'],
    exportedAt: 0,
    createdAt: now - 3 * 60 * MINUTE,
    updatedAt: now - 3 * 60 * MINUTE,
  },
]

export function makeEmptyThread(projectId: string, overrides: Partial<Thread> = {}): Thread {
  /* 预览里也带上 workdir —— 和桌面版从会话文件读出来的形状保持一致 */
  const project = DEFAULT_PROJECTS.find((p) => p.id === projectId)
  return {
    id: uid('thread'),
    projectId,
    ...(project?.path ? { workdir: project.path } : {}),
    title: '新对话',
    messages: [],
    status: 'idle',
    mode: 'pair',
    model: 'demo-standard',
    reasoning: 'medium',
    pinned: false,
    archived: false,
    tags: [],
    exportedAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    temporary: false,
    ...overrides,
  }
}
