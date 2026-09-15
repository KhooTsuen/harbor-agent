/* ══════════════════════════════════════════════════════════════
   Composer 两个补全菜单的数据

   命令是本地可执行的轻量入口；文件补全由 Composer 从真实工作目录加载。
   ══════════════════════════════════════════════════════════════ */

/* ── 斜杠命令 / @ 提及 的开发预览补全 ─────────────────────── */

export const SLASH_COMMANDS = [
  { cmd: '/plan', desc: '切换计划模式' },
  { cmd: '/goal', desc: '设一个持续目标' },
  { cmd: '/review', desc: '审查未提交的改动' },
  { cmd: '/compact', desc: '压缩当前上下文' },
  { cmd: '/model', desc: '换个模型' },
  { cmd: '/status', desc: '看看上下文用量' },
  { cmd: '/new', desc: '新建对话' },
  { cmd: '/clear', desc: '清空当前对话消息' },
  { cmd: '/readonly', desc: '本轮只读，不修改文件' },
  { cmd: '/research', desc: '研究模式，优先联网查证' },
  { cmd: '/agent', desc: '执行模式，允许完成任务' },
  { cmd: '/temporary', desc: '切换为临时对话，不写长期记忆' },
] as const

export const MENTIONS = [
  { name: '@src/components', desc: '目录' },
  { name: '@src/lib/utils.ts', desc: '文件' },
  { name: '@package.json', desc: '文件' },
  { name: '@README.md', desc: '文件' },
] as const
