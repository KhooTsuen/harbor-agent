import { Shield } from 'lucide-react'
import { useConfigStore } from '@/stores/useConfigStore'
import { Field } from '@/components/ui/Field'
import { Row } from '../parts'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   当前权限状态 —— 「现在到底允许它做什么」

   ── 为什么要有这一块 ──────────────────────────────────────────
   原来这一页最上面只有一个 `radiogroup`：三张卡，选中的那张有个 ●。
   用户的问题是「选了之后到底变成什么」—— 卡下面那行小字在选之前
   读不到差别，选之后又已经忘了我刚才是哪一档。

   所以第一屏先给一句**总结**（当前档 + 它意味着什么 + 还有哪几层
   在起作用），下面才是三档选择。顺序是「看清 → 再改」。

   ── 三层关系必须说清（用户报过「选了全放行还被弹窗」）──────────
     ① 权限档   —— 要不要**问你**
     ② Shell 策略 —— 这**类命令**要不要拦（在下一节）
     ③ 内核硬闸 —— 危急命令、敏感路径、凭证读取：**任何档位都拦**
   只有 ① 能在这块里改；② 在下面一节；③ 根本不是配置项。
   ══════════════════════════════════════════════════════════════ */

const PERMISSIONS = [
  {
    id: 'readonly' as const,
    label: '只读',
    hint: '只能看文件，不能改。让它先调研、你自己动手时用。',
  },
  {
    id: 'ask' as const,
    label: '需要确认',
    hint: '写文件、改文件、跑命令（含低风险）都会弹窗问你。默认推荐。',
  },
  {
    id: 'full' as const,
    label: '完全访问',
    hint: '不再弹任何确认框：写文件、跑命令（含高风险）、工作目录之外的文件都直接执行。要拦住某类命令，把下面的 Shell 策略设成「拦住」；注意那边设成「每次先问」在这一档下不会生效（设了也不问）。',
  },
]

export function PermissionLevelSummary(): React.ReactElement | null {
  const config = useConfigStore((s) => s.config)
  const patchTools = useConfigStore((s) => s.patchTools)
  if (!config) {
    return (
      <p className="px-3 py-2 text-dense leading-relaxed text-fg-tertiary">
        当前运行在浏览器预览环境，权限配置请在桌面版中使用。
      </p>
    )
  }

  const current = config.tools.permission
  const picked = PERMISSIONS.find((p) => p.id === current) ?? PERMISSIONS[1]

  return (
    <>
      <div
        className="mx-1 flex flex-col gap-1.5 rounded-base border px-3 py-2.5"
        style={{ borderColor: colorOf(current === 'full' ? 'warning' : 'completed') }}
        data-permission-level={current}
      >
        <span className="flex items-center gap-2 text-dense text-fg-primary">
          <Shield size={13} className="shrink-0" />
          现在是「{picked.label}」
        </span>
        <span className="text-dense leading-relaxed text-fg-secondary">{picked.hint}</span>
        <span className="text-2xs leading-relaxed text-fg-tertiary">
          另外还有两层不在这三档里：下面的 Shell 策略（这类命令要不要拦）、以及内核里写死的
          硬闸（危急命令、敏感路径、凭证读取 —— 任何档位都拦，改设置绕不过）。
        </span>
      </div>

      <Row label="工具权限" hint="决定写文件、跑命令时要不要弹窗问你">
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="工具权限">
          {PERMISSIONS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={current === p.id}
              onClick={() => void patchTools({ permission: p.id })}
              className={
                current === p.id
                  ? 'acrylic-card text-left'
                  : 'acrylic-card text-left transition-colors hover:bg-bg-hover'
              }
            >
              <span className="flex items-center gap-2 text-dense text-fg-primary">
                {p.label}
                {current === p.id ? <span className="text-2xs text-fg-secondary">●</span> : null}
              </span>
              <span className="mt-0.5 block text-2xs leading-relaxed text-fg-tertiary">
                {p.hint}
              </span>
            </button>
          ))}
        </div>
      </Row>

      <Row label="命令超时（秒）" hint="跑一条命令最多等多久；到点了按超时处理（分类成可重试）">
        <Field
          type="number"
          value={String(config.tools.shellTimeout)}
          onChange={(v) => void patchTools({ shellTimeout: Number(v) || 60 })}
        />
      </Row>
    </>
  )
}
