import type { DiffFile, TerminalLine } from '@/types'
import { uid } from '@/lib/utils'
import type { MockProject } from './types'

/* ══════════════════════════════════════════════════════════════
   模拟内容：Diff 与终端输出
   ══════════════════════════════════════════════════════════════ */

/* ── Diff ──────────────────────────────────────────────────── */

export function diffFixNullGuard(): DiffFile {
  return {
    path: 'src/lib/parser.ts',
    additions: 4,
    deletions: 2,
    hunks: [
      {
        header: '@@ -12,9 +12,11 @@ export function parseConfig(raw: string)',
        lines: [
          {
            type: 'context',
            content: '  const lines = raw.split("\\n")',
            oldLineNumber: 12,
            newLineNumber: 12,
          },
          {
            type: 'context',
            content: '  const result: Record<string, string> = {}',
            oldLineNumber: 13,
            newLineNumber: 13,
          },
          {
            type: 'remove',
            content: '  for (let i = 0; i < lines.length; i++) {',
            oldLineNumber: 14,
          },
          { type: 'remove', content: '    const [k, v] = lines[i].split("=")', oldLineNumber: 15 },
          { type: 'add', content: '  for (const line of lines) {', newLineNumber: 14 },
          { type: 'add', content: '    const trimmed = line.trim()', newLineNumber: 15 },
          {
            type: 'add',
            content: '    if (!trimmed || trimmed.startsWith("#")) continue',
            newLineNumber: 16,
          },
          { type: 'add', content: '    const [k, v] = trimmed.split("=")', newLineNumber: 17 },
          { type: 'context', content: '    result[k] = v', oldLineNumber: 16, newLineNumber: 18 },
          { type: 'context', content: '  }', oldLineNumber: 17, newLineNumber: 19 },
        ],
      },
    ],
  }
}

export function diffFixEffect(): DiffFile {
  return {
    path: 'src/components/chat/MessageList.tsx',
    additions: 3,
    deletions: 5,
    hunks: [
      {
        header: '@@ -28,11 +28,9 @@ export function MessageList({ messages }: Props)',
        lines: [
          {
            type: 'context',
            content: '  const bottomRef = useRef<HTMLDivElement>(null)',
            oldLineNumber: 28,
            newLineNumber: 28,
          },
          { type: 'remove', content: '  useEffect(() => {', oldLineNumber: 29 },
          { type: 'remove', content: '    bottomRef.current?.scrollIntoView()', oldLineNumber: 30 },
          { type: 'remove', content: '  })', oldLineNumber: 31 },
          { type: 'add', content: '  useLayoutEffect(() => {', newLineNumber: 29 },
          {
            type: 'add',
            content: '    bottomRef.current?.scrollIntoView({ block: "end" })',
            newLineNumber: 30,
          },
          { type: 'add', content: '  }, [messages.length])', newLineNumber: 31 },
          { type: 'context', content: '', oldLineNumber: 32, newLineNumber: 32 },
          {
            type: 'context',
            content: '  return <div className="flex flex-col gap-4">',
            oldLineNumber: 33,
            newLineNumber: 33,
          },
        ],
      },
    ],
  }
}

/* ── 终端 ──────────────────────────────────────────────────── */

export function terminalRun(project: MockProject): TerminalLine[] {
  const now = Date.now()
  return [
    { id: uid('tl'), type: 'input', content: 'npm run dev', timestamp: now },
    { id: uid('tl'), type: 'output', content: '> vite --host', timestamp: now + 120 },
    {
      id: uid('tl'),
      type: 'output',
      content: '  VITE v5.4.21  ready in 412 ms',
      timestamp: now + 900,
    },
    {
      id: uid('tl'),
      type: 'output',
      content: '  ➜  Local:   http://localhost:5273/',
      timestamp: now + 910,
    },
    {
      id: uid('tl'),
      type: 'info',
      content: `  project: ${project.path}  branch: ${project.branch}`,
      timestamp: now + 920,
    },
  ]
}

export function terminalTest(project: MockProject): TerminalLine[] {
  const now = Date.now()
  return [
    { id: uid('tl'), type: 'input', content: 'npx vitest run', timestamp: now },
    {
      id: uid('tl'),
      type: 'output',
      content: ` RUN  v2.1.4 ${project.path}`,
      timestamp: now + 200,
    },
    {
      id: uid('tl'),
      type: 'output',
      content: ' ✓ src/lib/utils.test.ts (3 tests) 18ms',
      timestamp: now + 640,
    },
    {
      id: uid('tl'),
      type: 'output',
      content: ' ✓ src/lib/parser.test.ts (7 tests) 31ms',
      timestamp: now + 700,
    },
    {
      id: uid('tl'),
      type: 'error',
      content: ' ✗ src/components/chat/composer.test.tsx (1 test | 1 failed)',
      timestamp: now + 980,
    },
    {
      id: uid('tl'),
      type: 'error',
      content: '   → expected "中" but received "high"',
      timestamp: now + 1000,
    },
    {
      id: uid('tl'),
      type: 'info',
      content: ' Tests  10 passed | 1 failed (11)   Time  1.34s',
      timestamp: now + 1200,
    },
  ]
}

export function terminalGit(): TerminalLine[] {
  const now = Date.now()
  return [
    { id: uid('tl'), type: 'input', content: 'git status --short', timestamp: now },
    { id: uid('tl'), type: 'output', content: ' M src/lib/parser.ts', timestamp: now + 90 },
    {
      id: uid('tl'),
      type: 'output',
      content: ' M src/components/chat/MessageList.tsx',
      timestamp: now + 100,
    },
    { id: uid('tl'), type: 'output', content: '?? src/lib/mockAI.ts', timestamp: now + 110 },
    { id: uid('tl'), type: 'input', content: 'git diff --stat', timestamp: now + 400 },
    {
      id: uid('tl'),
      type: 'output',
      content: ' src/lib/parser.ts                    | 6 +++---',
      timestamp: now + 480,
    },
    {
      id: uid('tl'),
      type: 'output',
      content: ' src/components/chat/MessageList.tsx | 8 +++-----',
      timestamp: now + 490,
    },
    {
      id: uid('tl'),
      type: 'info',
      content: ' 2 files changed, 7 insertions(+), 9 deletions(-)',
      timestamp: now + 500,
    },
  ]
}
