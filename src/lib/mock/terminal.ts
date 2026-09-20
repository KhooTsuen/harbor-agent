import type { TerminalLine } from '@/types'
import { BRAND_NAME } from '@/constants'
import { uid } from '@/lib/utils'
import type { MockProject } from './types'

/* ══════════════════════════════════════════════════════════════
   模拟终端

   覆盖：ls / cd / pwd / cat / echo / touch / mkdir / rm / node /
        git / npm run dev / clear / help
   全部是**假的**，不会真的动用户文件。
   ══════════════════════════════════════════════════════════════ */

export function initialTerminal(project: MockProject): TerminalLine[] {
  const now = Date.now()
  return [
    {
      id: uid('tl'),
      type: 'info',
      content: `${BRAND_NAME} 终端（模拟）—— ${project.path}`,
      timestamp: now,
    },
    { id: uid('tl'), type: 'output', content: '输入 help 看可用命令。', timestamp: now + 10 },
  ]
}

/**
 * 跑一条模拟命令。
 *
 * 覆盖：ls / cd / pwd / cat / echo / touch / mkdir / rm / node / git /
 *       npm run dev / clear / help
 */
export function terminalForCommand(
  command: string,
  project: MockProject,
  cwd: string,
): TerminalLine[] {
  const now = Date.now()
  const cmd = command.trim()
  const line = (type: TerminalLine['type'], content: string, offset = 0): TerminalLine => ({
    id: uid('tl'),
    type,
    content,
    timestamp: now + offset,
  })

  const where = cwd && cwd !== project.path ? `（当前目录 ${cwd}）` : ''

  if (cmd === 'help') {
    return [
      line('info', `项目：${project.name}${where}`),
      line('output', '可用命令：', 10),
      line('output', '  ls              列出目录', 20),
      line('output', '  cd <dir>        切换目录', 30),
      line('output', '  pwd             显示当前目录', 40),
      line('output', '  cat <file>      查看文件内容', 50),
      line('output', '  echo <text>     输出文本', 60),
      line('output', '  touch <file>    新建空文件', 70),
      line('output', '  mkdir <dir>     新建目录', 80),
      line('output', '  node -v         查看 Node 版本', 90),
      line('output', '  git status      看工作区状态', 100),
      line('output', '  npm run dev     起开发服务器', 110),
      line('output', '  clear           清屏', 120),
      line('info', '（这是模拟终端，不会真的动你的文件）', 130),
    ]
  }

  if (cmd === 'ls') {
    return [line('output', 'src/  public/  package.json  tsconfig.json  vite.config.ts  README.md')]
  }

  if (cmd === 'pwd') {
    return [line('output', cwd || project.path)]
  }

  if (cmd.startsWith('cd')) {
    const target = cmd.slice(2).trim() || '~'
    return [line('info', `（模拟）已切换到 ${target}`)]
  }

  if (cmd.startsWith('cat ')) {
    const target = cmd.slice(4).trim()
    return [line('output', `（模拟）${target} 的内容不会真的读出来，去右侧「文件」标签看真实文件`)]
  }

  if (cmd.startsWith('echo ')) {
    return [line('output', cmd.slice(5))]
  }

  if (cmd.startsWith('touch ')) {
    return [line('info', `（模拟）已创建空文件 ${cmd.slice(6).trim()}`)]
  }

  if (cmd.startsWith('mkdir ')) {
    return [line('info', `（模拟）已创建目录 ${cmd.slice(6).trim()}`)]
  }

  if (cmd.startsWith('rm ')) {
    return [
      line('info', `（模拟）已删除 ${cmd.slice(3).trim()}`),
      line('error', '注意：这里不会真的删任何东西', 10),
    ]
  }

  if (cmd.startsWith('node')) {
    return [line('output', 'v24.19.0')]
  }

  if (cmd.startsWith('npm run') || cmd.startsWith('npm start')) {
    return [
      line('output', '> vite --host', 100),
      line('output', '  VITE v5.4.21  ready in 398 ms', 800),
      line('output', '  ➜  Local:   http://localhost:5273/', 810),
    ]
  }

  if (cmd.startsWith('git status')) {
    return [
      line('output', ' M src/lib/parser.ts', 90),
      line('output', ' M src/components/chat/MessageList.tsx', 100),
      line('output', '?? src/lib/mock/index.ts', 110),
    ]
  }

  return [
    line('error', `command not found: ${cmd.split(' ')[0]}`),
    line('info', '（这是模拟终端，试试 help）', 10),
  ]
}
