import { CheckCircle2, Pencil, ShieldCheck, Trash2 } from 'lucide-react'
import type { ExperienceItem } from '@/types/experience'
import { Button } from '@/components/ui/Button'
import { colorOf } from '@/lib/statusLanguage'
import { STATUS_COLOR, metaOf, needsDraftInput } from '@/lib/experienceDisplay'

/* ══════════════════════════════════════════════════════════════
   经验列表里的一条（含逐条动作）

   从 `ExperienceTab.tsx` 抽出来的（那边 299 行贴顶，第二阶段要重排层级
   必须先腾地方）。这一块自成一件事：**一条经验的证据 + 能对它做什么**。

   ── 第二阶段重排：证据在前，动作在后，分两条线看 ──────────────
   以前是「触发器 + 做法 + 原因 + 元信息 + 输入框 + 一排按钮」全挤在
   一个垂直流里，一屏只能看两条。现在：

     · 上半：说清「遇到了什么 / 建议怎么做 / 为什么」（只读）
     · 分隔：一条细线
     · 下半：元信息（类别、验证次数、会不会进提示）+ 动作按钮

   长文本用 `max-w-[70ch]` 收住 —— 一行太长眼睛要来回扫。

   ★ 判据没动：`needsDraftInput` 决定要不要那个输入框（没有系统做法时
     批准必须先写一句），`metaOf` 决定元信息有哪些片段。两处都在
     `lib/experienceDisplay`，这里不重写一份。
   ══════════════════════════════════════════════════════════════ */

export interface ExperienceRowProps {
  item: ExperienceItem
  /** 批准 / 改做法时手写的那句「该怎么做」 */
  draft: string
  onDraftChange: (value: string) => void
  /** 这一条是否正在「改做法」 */
  editing: boolean
  onStartEdit: () => void
  onAct: (action: 'approve' | 'reject' | 'restore' | 'amend') => void
}

export function ExperienceRow({
  item,
  draft,
  onDraftChange,
  editing,
  onStartEdit,
  onAct,
}: ExperienceRowProps): React.ReactElement {
  /* 已驳回 / 已弃用的条目不再提供「改做法」和「驳回」—— 驳回是终点 */
  const closed = item.status === 'rejected' || item.status === 'deprecated'

  return (
    <li
      className="acrylic-card flex flex-col gap-2.5"
      data-experience-id={item.id}
      data-experience-status={item.status}
      data-experience-category={item.category}
    >
      {/* ── 上半：这条经验说了什么（只读） ── */}
      <div className="max-w-[70ch]">
        <p className="break-words text-dense leading-relaxed text-fg-primary">{item.triggerText}</p>
        {item.recommendedAction ? (
          <p className="mt-1 break-words text-dense leading-relaxed text-fg-primary">
            <span className="text-fg-secondary">做法：</span>
            {item.recommendedAction}
          </p>
        ) : null}
        {item.causeHypothesis ? (
          <p className="mt-0.5 break-words text-2xs leading-relaxed text-fg-secondary">
            原因假设：{item.causeHypothesis}
          </p>
        ) : null}
      </div>

      {/*
       * 没有系统做法时批准必须先写一句；点了「改做法」也复用这个输入框。
       * 放在按钮**上面**：先填再点，顺序和操作直觉一致。
       */}
      {needsDraftInput(item, editing) ? (
        <input
          value={draft ?? (editing ? item.recommendedAction : '')}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="这次该怎么做？批准前必须写一句（会进提示）"
          aria-label="批准时使用的做法"
          className="w-full rounded-sm border border-line-subtle bg-bg-input px-2 py-1.5 text-dense text-fg-primary placeholder:text-fg-secondary focus:border-line-focus focus:outline-none"
        />
      ) : null}

      {/* ── 下半：元信息 + 动作 ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line-hairline pt-2">
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-secondary">
          {metaOf(item).map((bit) => (
            <span key={bit}>{bit}</span>
          ))}
          <span style={{ color: colorOf(STATUS_COLOR[item.status]) }}>
            {item.injectable ? '会进提示' : '不进提示'}
          </span>
          <span>{item.target || '（没有目标）'}</span>
          {item.blockedReason ? <span>{item.blockedReason}</span> : null}
        </p>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {item.status === 'candidate' ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<ShieldCheck size={12} />}
              onClick={() => onAct('approve')}
              aria-label="批准这条经验"
            >
              批准
            </Button>
          ) : null}

          {item.status === 'suspended' ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<CheckCircle2 size={12} />}
              onClick={() => onAct('restore')}
              aria-label="恢复这条经验"
            >
              恢复
            </Button>
          ) : null}

          {item.recommendedAction && !closed ? (
            editing ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Pencil size={12} />}
                onClick={() => onAct('amend')}
                aria-label="保存修改后的做法"
              >
                保存
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                icon={<Pencil size={12} />}
                onClick={onStartEdit}
                aria-label="修改这条经验的做法"
              >
                改做法
              </Button>
            )
          ) : null}

          {!closed ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={12} />}
              onClick={() => onAct('reject')}
              aria-label="驳回这条经验"
            >
              驳回
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  )
}
