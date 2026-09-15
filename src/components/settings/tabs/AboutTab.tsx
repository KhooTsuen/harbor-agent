import { APP_VERSION } from '@/lib/backend'

/* ══════════════════════════════════════════════════════════════
   设置 → 关于
   ══════════════════════════════════════════════════════════════ */

const DEPENDENCIES = [
  'React · MIT',
  'Vite · MIT',
  'Tailwind CSS · MIT',
  'Zustand · MIT',
  'Framer Motion · MIT',
  'Lucide · ISC',
  'Electron · MIT',
]

export function AboutTab() {
  return (
    <div className="py-4 text-dense leading-relaxed text-fg-secondary">
      <h3 className="text-body font-semibold text-fg-primary">Personal Agent</h3>
      <p className="mt-1 text-2xs text-fg-tertiary">{`版本 ${APP_VERSION}`}</p>

      <div className="mt-4 flex flex-col gap-2">
        <p>
          本地优先的个人 AI Agent 工作台。Electron 主进程负责文件、命令和模型请求， 渲染层是
          React，两边通过 preload 的白名单桥通信。
        </p>
        <p className="text-2xs text-fg-tertiary">
          配色不是照设计规范抄的，是从 23 张同类界面截图里用像素统计量出来的。 另外备了一套「ChatGPT
          桌面端基准」主题，可以随时切过去对照。
        </p>
      </div>

      <h4 className="mt-5 text-2xs uppercase tracking-wide text-fg-tertiary">数据放在哪</h4>
      <p className="mt-2 text-2xs leading-relaxed text-fg-tertiary">
        全部在软件目录的 <span className="font-mono">data/</span> 下：
        <span className="font-mono">config.json</span> 是设置，
        <span className="font-mono">sessions/</span> 是会话（每会话一个 jsonl），
        <span className="font-mono">logs/</span> 是日志。删掉整个文件夹就等于卸载。
      </p>

      <h4 className="mt-5 text-2xs uppercase tracking-wide text-fg-tertiary">更新日志</h4>
      <ul className="mt-2 flex flex-col gap-1.5 text-2xs">
        <li className="flex gap-2">
          <span className="shrink-0 font-mono text-fg-tertiary">0.1.0</span>
          <span>
            首个版本：三栏布局、对话与 agent 循环、工具系统与权限三档、Diff 审查、终端、文件树、
            多线程、命令面板、设置
          </span>
        </li>
      </ul>

      <h4 className="mt-5 text-2xs uppercase tracking-wide text-fg-tertiary">开源许可</h4>
      <ul className="mt-2 flex flex-col gap-1 font-mono text-2xs text-fg-tertiary">
        {DEPENDENCIES.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
