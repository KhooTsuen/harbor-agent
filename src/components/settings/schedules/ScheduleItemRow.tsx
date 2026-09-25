import { AlertTriangle, Loader2, Pencil, Play, Trash2 } from 'lucide-react'
import type { ScheduleGrantInfo, ScheduleItem } from '@/lib/schedulesApi'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Switch } from '@/components/ui/Field'
import { GrantBadge, lastRunText, nextRunText } from './ScheduleParts'

/* ══════════════════════════════════════════════════════════════
   定时任务列表里的一条

   这里刻意**不显示倒计时**，只显示下一次的**时刻**：倒计时要靠前端定时器自己算，
   而真正决定「跑不跑」的是内核的心跳（30 秒一跳）—— 显示一个自己算的秒数
   只会和实际差出几十秒，用户按那个数字等就会以为坏了。

   「立即运行」按下去**不是跑完了**：内核不 await（一条任务能跑几分钟），
   所以按钮只负责发起，进度在右侧「任务」和那条专属会话里看。
   ══════════════════════════════════════════════════════════════ */

export function ScheduleItemRow({
  item,
  info,
  running,
  busy,
  onToggle,
  onRunNow,
  onEdit,
  onRemove,
}: {
  item: ScheduleItem
  /** 这一档的人话说明（内核原文；null = 内核没给，徽章退回显示 id） */
  info: ScheduleGrantInfo | null
  /** 正在跑（内核内存里的状态，不落盘） */
  running: boolean
  /** 这一条正有操作在飞，按钮先别让按第二下 */
  busy: boolean
  onToggle: (next: boolean) => void
  onRunNow: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const blocked = Number(item.blockedCount) > 0

  return (
    <li className="rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-dense text-fg-primary">{item.name}</span>
            <GrantBadge grant={item.grant} info={info} />
            <span className={`text-2xs ${item.enabled ? 'text-success' : 'text-fg-tertiary'}`}>
              {item.enabled ? '启用中' : '已停用'}
            </span>
            {running ? (
              <span className="flex items-center gap-1 text-2xs text-accent">
                <Loader2 size={11} className="animate-spin" />
                正在跑
              </span>
            ) : null}
          </div>

          <p className="mt-1 text-dense leading-relaxed text-fg-secondary">
            {item.whenText} · 下次 {nextRunText(item.nextRunAt)} · 上次{' '}
            {lastRunText(item.lastRunAt)}
          </p>

          <p className="mt-1 break-words text-2xs leading-relaxed text-fg-tertiary">
            上次结果：{item.lastResult || '还没跑过'}
          </p>

          <p className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-fg-tertiary">
            <span>跑过 {item.runCount} 次</span>
            <span className={blocked ? 'font-medium text-warning' : undefined}>
              被拒 {item.blockedCount} 次
            </span>
            {item.sessionId ? (
              <span className="font-mono" title={item.sessionId}>
                专属会话 {item.sessionId.slice(0, 10)}
              </span>
            ) : null}
          </p>

          {blocked ? (
            <p className="mt-1 flex items-start gap-1 text-2xs leading-relaxed text-warning">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>
                有操作被拒了。没人在场就没人能批准，需要确认的一律按拒绝处理 ——
                这条任务想跑完，得改成「不用确认就能安全跑」的干法。
              </span>
            </p>
          ) : null}

          {item.workdir ? (
            <p className="mt-1 truncate font-mono text-2xs text-fg-tertiary" title={item.workdir}>
              工作目录 {item.workdir}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={item.enabled}
            disabled={busy}
            label={item.enabled ? `停用「${item.name}」` : `启用「${item.name}」`}
            onChange={onToggle}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={<Play size={13} />}
            disabled={busy}
            onClick={onRunNow}
          >
            立即运行
          </Button>
          <IconButton label="编辑这条定时任务" size={28} disabled={busy} onClick={onEdit}>
            <Pencil size={13} />
          </IconButton>
          <IconButton label="删除这条定时任务" size={28} disabled={busy} onClick={onRemove}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      </div>
    </li>
  )
}
