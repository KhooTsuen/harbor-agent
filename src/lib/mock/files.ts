import type { FileNode } from '@/types'
import { uid } from '@/lib/utils'
import type { MockProject } from './types'

/* ══════════════════════════════════════════════════════════════
   模拟数据：文件树

   文件内容写成真实项目的样子，预览时才有东西看。
   ══════════════════════════════════════════════════════════════ */

function file(name: string, language: string, content: string): FileNode {
  return { id: uid('fn'), name, type: 'file', language, content }
}

function folder(name: string, children: FileNode[]): FileNode {
  return { id: uid('fn'), name, type: 'folder', children }
}

export function buildFileTree(project: MockProject): FileNode {
  return folder(project.name, [
    folder('src', [
      folder('components', [
        folder('chat', [
          file(
            'MessageList.tsx',
            'tsx',
            `import { useLayoutEffect, useRef } from 'react'
import type { Message } from '@/types'
import { MessageItem } from './MessageItem'

interface Props {
  messages: Message[]
}

export function MessageList({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // 用 useLayoutEffect：要在浏览器绘制之前滚到底，否则会看到跳动
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  return (
    <div className="flex flex-col gap-4 px-6 py-4">
      {messages.map((m) => (
        <MessageItem key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}`,
          ),
          file(
            'Composer.tsx',
            'tsx',
            `import { useState } from 'react'
import { ArrowUp, Paperclip } from 'lucide-react'

export function Composer() {
  const [value, setValue] = useState('')
  const canSend = value.trim().length > 0

  return (
    <div className="glass-medium rounded border border-line-hairline p-3">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="想让 Agent 做什么？"
        className="w-full resize-none bg-transparent text-body outline-none"
        rows={2}
      />
      <div className="mt-xs flex items-center gap-2">
        <button className="rounded-small p-1.5 hover:bg-bg-hover" aria-label="添加附件">
          <Paperclip size={16} />
        </button>
        <button
          disabled={!canSend}
          className="ml-auto grid size-8 place-items-center rounded-pill bg-cta text-cta-fg disabled:opacity-40"
          aria-label="发送"
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  )
}`,
          ),
        ]),
      ]),
      folder('lib', [
        file(
          'utils.ts',
          'typescript',
          `export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return \`\${min} 分\`
  const hours = Math.floor(min / 60)
  if (hours < 24) return \`\${hours} 时\`
  return \`\${Math.floor(hours / 24)} 天\`
}`,
        ),
        file(
          'parser.ts',
          'typescript',
          `export function parseConfig(raw: string): Record<string, string> {
  const lines = raw.split('\\n')
  const result: Record<string, string> = {}

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [k, v] = trimmed.split('=')
    result[k] = v
  }

  return result
}`,
        ),
      ]),
      file(
        'App.tsx',
        'tsx',
        `import { Sidebar } from './components/layout/Sidebar'
import { ChatPanel } from './components/chat/ChatPanel'
import { RightPanel } from './components/layout/RightPanel'

export default function App() {
  return (
    <div className="flex h-full">
      <Sidebar />
      <ChatPanel />
      <RightPanel />
    </div>
  )
}`,
      ),
      file(
        'index.css',
        'css',
        `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --bg-canvas: #101010;
  --bg-surface: #202020;
  --text-primary: #f8f8f8;
}`,
      ),
    ]),
    file(
      'package.json',
      'json',
      `{
  "name": "${project.name}",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^4.5.5"
  }
}`,
    ),
    file(
      'README.md',
      'markdown',
      `# ${project.name}

## 开发

\`\`\`bash
npm install
npm run dev
\`\`\`

## 分支

当前分支：\`${project.branch}\`
`,
    ),
    file(
      'tsconfig.json',
      'json',
      `{
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}`,
    ),
  ])
}
