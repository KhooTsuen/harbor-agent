/* ══════════════════════════════════════════════════════════════
   模拟层统一出口

   拆成多个文件是为了让单文件保持在 300 行以内。
   调用方只需要 `import { … } from '@/lib/mock'`。
   ══════════════════════════════════════════════════════════════ */

export {
  buildReply,
  detectIntent,
  deriveTitle,
  generateReply,
  generateReplyStream,
  type Intent,
  type StreamOptions,
} from './ai'

export { codeSplitHunks, codeTests, codeTokens, codeUseDebounce } from './content'

export { diffFixEffect, diffFixNullGuard, terminalGit, terminalRun, terminalTest } from './snippets'

export { buildFileTree } from './files'

export { initialTerminal, terminalForCommand } from './terminal'

export { DEFAULT_PROJECTS, DEFAULT_THREADS, makeEmptyThread } from './seed'
