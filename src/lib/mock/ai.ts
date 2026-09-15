import type { Message, MessageKind, ReplyPayload, Thread } from '@/types'
import { uid } from '@/lib/utils'
import { codeSplitHunks, codeTests, codeTokens, codeUseDebounce } from './content'
import { diffFixEffect, diffFixNullGuard, terminalTest } from './snippets'
import type { MockProject } from './types'

/* ══════════════════════════════════════════════════════════════
   模拟 AI

   浏览器模式 / 没配 API Key 时用。
   按关键词切三种回复形态：代码块 / diff / 终端输出。
   ══════════════════════════════════════════════════════════════ */

/* ── 意图识别 ─────────────────────────────────────────────── */

export type Intent = 'code' | 'diff' | 'terminal' | 'test' | 'explain' | 'fallback'

const KEYWORDS: readonly { intent: Intent; words: readonly string[] }[] = [
  { intent: 'test', words: ['测试', 'test', '单测', '用例'] },
  { intent: 'diff', words: ['修复', '修一下', 'bug', '错误', '报错', 'fix', '告警', '崩溃'] },
  { intent: 'terminal', words: ['运行', '终端', '命令', '跑一下', '启动', 'npm', 'git', 'build'] },
  { intent: 'code', words: ['创建', '新建', '写一个', '实现', '组件', '函数', '加上', '加个'] },
  { intent: 'explain', words: ['解释', '为什么', '怎么回事', '什么意思', '讲讲', '分析'] },
] as const

export function detectIntent(input: string): Intent {
  const text = input.toLowerCase()
  for (const { intent, words } of KEYWORDS) {
    if (words.some((w) => text.includes(w.toLowerCase()))) return intent
  }
  return 'fallback'
}

/* ── 按意图产出回复 ───────────────────────────────────────── */

export function buildReply(input: string, thread: Thread, project: MockProject): ReplyPayload {
  const intent = detectIntent(input)

  if (intent === 'code') {
    const block = codeUseDebounce()
    return {
      kind: 'code',
      content: `写了一个 useDebounced。要点：

- 用 \`useEffect\` 的清理函数取消上一个定时器，这是防抖的关键；
- 返回值和入参同类型，泛型直接跟着走，不用调用方标注；
- delay 放在依赖数组里，运行期改了也能生效。

如果你要的是「节流」（固定频率触发）而不是「防抖」（停手后才触发），告诉我，那个写法不一样。`,
      codeBlocks: [block],
    }
  }

  if (intent === 'diff') {
    const primary = diffFixNullGuard()
    return {
      kind: 'diff',
      content: `找到了，问题在这里。

**原因**：原代码假设每一行都是 \`key=value\`，但配置文件里有空行和注释行，\`split('=')\` 之后拿到的是长度 1 的数组，解构出来的 \`v\` 就是 \`undefined\`。

**改动**（${primary.additions} 增 / ${primary.deletions} 删）：
1. 用 \`for...of\` 替掉下标循环，顺便去掉越界可能；
2. 跳过空行和 \`#\` 注释；
3. 顺手 trim，避免 \`key = value\` 这种写法解析出带空格的 key。`,
      diffs: [primary, diffFixEffect()],
    }
  }

  if (intent === 'terminal') {
    return {
      kind: 'terminal',
      content:
        '跑了一下，开发服务器起得来，但测试有一条没过——断言里期望中文档位，实际拿到的是英文枚举值。',
      terminalLines: terminalTest(project),
    }
  }

  if (intent === 'test') {
    return {
      kind: 'code',
      content: `补了三个用例，重点在边界：

- 一分钟内 → 「刚刚」
- 跨小时换算 → 「N 时」
- **未来时间**不出现负数（时间戳来自别的机器时很容易踩到）

第三个是这类函数最常见的坑，建议保留。`,
      codeBlocks: [codeTests()],
    }
  }

  if (intent === 'explain') {
    return {
      kind: 'text',
      content: `这段用 \`useEffect(() => {...})\` 没写依赖数组，等于每次渲染都执行一遍。

滚动到底部这个动作本身不贵，但它在**每次渲染后**触发，而滚动又会带来新的渲染，量一大就出现明显掉帧。

正确写法是 \`useLayoutEffect\` + 只依赖 \`messages.length\`：

- 用 \`useLayoutEffect\` 是因为要在浏览器绘制**之前**滚到底，否则用户会先看到跳动再看到滚动；
- 依赖 \`messages.length\` 而不是整个数组，避免每次生成新数组引用都触发。`,
      codeBlocks: [codeSplitHunks()],
    }
  }

  return {
    kind: 'text',
    content: `收到。当前线程模式是「${thread.mode}」，模型 ${thread.model}，推理档位 ${thread.reasoning}。

我可以做这几类事情：

- **写代码** —— 说清你要什么功能；
- **改 bug** —— 把报错或异常行为贴给我；
- **跑命令** —— 需要我执行什么就说；
- **讲原理** —— 贴一段代码问我为什么。

左边栏可以开多个线程并行跑，互不干扰。`,
    codeBlocks: [codeTokens()],
  }
}

/* ── 流式输出 ────────────────────────────────────────────── */

/** 流式回调：只有 onChunk 是必需的，另两个给了就在对应时机调用 */
export interface StreamOptions {
  onChunk: (accumulated: string) => void
  onDone?: (payload: ReplyPayload) => void
  onError?: (message: string) => void
  /** 打字机速度倍率，0 = 一次性给完 */
  speed?: number
  signal: AbortSignal
}

function thinkingDelay(): number {
  return Math.floor(Math.random() * 1000) + 500
}

/** 可被 abort 打断的 sleep */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      window.clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function generateReplyStream(
  input: string,
  thread: Thread,
  project: MockProject,
  options: StreamOptions,
): Promise<ReplyPayload> {
  const { onChunk, signal, speed = 1 } = options

  if (signal.aborted) throw new DOMException('aborted', 'AbortError')

  /* 网络模拟：5% 概率失败，让「重试」按钮有存在意义 */
  const failRoll = Math.random()
  await wait(thinkingDelay(), signal)
  if (failRoll < 0.05) {
    throw new Error('连接上游模型超时（模拟故障，可点重试）')
  }

  const payload = buildReply(input, thread, project)

  if (speed === 0) {
    onChunk(payload.content)
    return payload
  }

  /* 逐字：20~40ms 一个字符，再按速度倍率缩放 */
  const chars = Array.from(payload.content)
  let buffer = ''
  for (const ch of chars) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    buffer += ch
    onChunk(buffer)
    const base = 20 + Math.floor(Math.random() * 20)
    await wait(Math.max(4, base / speed), signal)
  }

  return payload
}

/** 一次性拿完整 Message（给不想用流式的调用方） */
export async function generateReply(
  userInput: string,
  thread: Thread,
  project: MockProject,
): Promise<Message> {
  const payload = buildReply(userInput, thread, project)
  return {
    id: uid('msg'),
    threadId: thread.id,
    role: 'assistant',
    content: payload.content,
    kind: payload.kind as MessageKind,
    status: 'sent',
    timestamp: Date.now(),
    ...(payload.codeBlocks ? { codeBlocks: payload.codeBlocks } : {}),
    ...(payload.diffs ? { diffs: payload.diffs } : {}),
    ...(payload.terminalLines ? { terminalLines: payload.terminalLines } : {}),
  }
}

/* ── 标题 ─────────────────────────────────────────────────── */

const TITLE_PREFIX: Record<Intent, string> = {
  code: '实现',
  diff: '修复',
  terminal: '运行',
  test: '补测试',
  explain: '解释',
  fallback: '讨论',
}

export function deriveTitle(input: string): string {
  const clean = input.replace(/\s+/g, ' ').trim()
  if (!clean) return '新对话'
  const prefix = TITLE_PREFIX[detectIntent(clean)]
  return `${prefix}：${clean.length > 16 ? `${clean.slice(0, 16)}…` : clean}`
}
