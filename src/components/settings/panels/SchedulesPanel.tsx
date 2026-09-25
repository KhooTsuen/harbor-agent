import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, Plus, RefreshCw } from 'lucide-react'
import {
  schedulesBridgeReady,
  schedulesList,
  schedulesRemove,
  schedulesRunNow,
  schedulesSave,
  schedulesToggle,
  scheduleGrantInfo,
  type ScheduleDraft,
  type ScheduleItem,
  type ScheduleListSnapshot,
} from '@/lib/schedulesApi'
import { Button } from '@/components/ui/Button'
import { useUIStore } from '@/stores/useUIStore'
import { Row, SectionTitle } from '../parts'
import { ScheduleForm } from '../schedules/ScheduleForm'
import { ScheduleItemRow } from '../schedules/ScheduleItemRow'

/* ══════════════════════════════════════════════════════════════
   设置 → 扩展 → 定时任务

   定时任务和别的功能的区别只有一条，但它是所有设计的出发点：
   **没人在场。**

   所以这一页上「授权上限」不是高级选项，是主角（三档的说明由内核给，
   这里只负责原样摆出来）；而且顶上必须先把三句实话说了 ——
   不然用户会以为它是个「云端定时器」，关掉电脑也照跑。

   顺带一条纪律：「立即运行」返回的是 `started`，不是 `finished`。
   内核不 await 那条任务（一次能跑几分钟），所以提示语只能说「已开始」，
   进度去右侧任务台账和那条专属会话里看。
   ══════════════════════════════════════════════════════════════ */

/** 三句实话。顺序也讲究：先「什么时候跑」，再「跑起来会被拒什么」，最后「去哪看」 */
const TRUTHS: readonly string[] = [
  '只在应用开着的时候跑。关掉应用它就停在原地，下次打开也不会「补跑」欠下的那些次。',
  '需要你确认的操作一律按拒绝处理 —— 没人在场就没人能批准。所以定时任务只能干「不需要确认就能安全跑」的事。',
  '每次跑都开在一个专属会话里，它到底干了什么、哪一步被拒了，都能在侧栏看到。',
]

export function SchedulesPanel() {
  const showToast = useUIStore((s) => s.showToast)
  const askPermission = useUIStore((s) => s.askPermission)

  /* 桥接状态在一次渲染里是常量（模块加载时就定了），不用做成 state */
  const ready = schedulesBridgeReady()

  const [snapshot, setSnapshot] = useState<ScheduleListSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  /** 正在编辑的那条；null = 不在编辑 */
  const [editing, setEditing] = useState<ScheduleItem | null>(null)
  const [creating, setCreating] = useState(false)
  /** 哪一条上有操作在飞（开关 / 立即运行 / 删除） */
  const [busyId, setBusyId] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setSnapshot(await schedulesList())
    setLoading(false)
  }, [])

  useEffect(() => {
    if (ready) void refresh()
  }, [ready, refresh])

  /*
   * 有任务在跑时每 5 秒刷一次列表 —— 不然「正在跑」会一直挂着，
   * 用户以为卡死了。依赖用**原始值** runningCount：用整个 snapshot 会
   * 每次刷新都重建定时器（zustand / effect 那个老坑，见渲染层规矩）。
   */
  const runningCount = snapshot?.running.length ?? 0
  useEffect(() => {
    if (runningCount === 0) return
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [runningCount, refresh])

  async function handleToggle(item: ScheduleItem, next: boolean): Promise<void> {
    setBusyId(item.id)
    const result = await schedulesToggle(item.id, next)
    setBusyId('')
    if (!result.ok) {
      showToast('error', '这个开关没改成功', result.error)
      return
    }
    await refresh()
  }

  async function handleRunNow(item: ScheduleItem): Promise<void> {
    setBusyId(item.id)
    const result = await schedulesRunNow(item.id)
    setBusyId('')
    if (!result.ok) {
      showToast('error', '没跑起来', result.error)
      return
    }
    /* ★ 内核不 await，所以这里只能说「已开始」。说成「跑完了」就是骗人 */
    showToast('info', '已开始，这里不会等它跑完', '去右侧「任务」或那条专属会话里看进度和结果。')
    await refresh()
  }

  function handleRemove(item: ScheduleItem): void {
    askPermission({
      kind: 'clear-data',
      title: `删除定时任务「${item.name}」？`,
      description:
        '只删这条调度和它的运行记录（runCount / 上次结果），已经跑出来的会话和成果都留着。删掉之后不能再恢复。',
      confirmText: '删除',
      danger: true,
      onConfirm: () => {
        void (async () => {
          setBusyId(item.id)
          const result = await schedulesRemove(item.id)
          setBusyId('')
          if (!result.ok) {
            showToast('error', '删除失败', result.error)
            return
          }
          if (editing?.id === item.id) setEditing(null)
          await refresh()
          showToast('success', '已删除')
        })()
      },
    })
  }

  async function handleSave(draft: ScheduleDraft): Promise<{ ok: boolean; error?: string }> {
    const result = await schedulesSave(draft)
    /* 失败原因原样带回表单显示（内核比前端知道得多） */
    if (!result.ok) return { ok: false, error: result.error }
    setCreating(false)
    setEditing(null)
    await refresh()
    showToast('success', draft.id ? '已保存' : '已创建', '到点后它自己会跑 —— 应用得开着。')
    return { ok: true }
  }

  if (!ready) {
    return (
      <div className="flex flex-col gap-2 py-1">
        <SectionTitle hint="关掉应用就不跑了">定时任务</SectionTitle>
        <ScheduleTruths />
        <p className="py-2 text-dense leading-relaxed text-fg-tertiary">
          这里读不到内核（浏览器预览没有主进程），定时任务在这个环境里用不了 ——
          打开桌面版才有这一页。别的设置不受影响。
        </p>
      </div>
    )
  }

  const items = snapshot?.items ?? []

  return (
    <div className="flex flex-col gap-2 py-1">
      <SectionTitle hint="关掉应用就不跑了">定时任务</SectionTitle>
      <ScheduleTruths />

      {loading ? (
        <p className="py-3 text-dense text-fg-tertiary">读取中…</p>
      ) : snapshot === null ? (
        <p className="py-3 text-dense leading-relaxed text-fg-tertiary">
          列表读不出来（内核没返回）。不影响别的功能，可以点「刷新」再试一次。
        </p>
      ) : items.length === 0 ? (
        <p className="py-3 text-dense leading-relaxed text-fg-secondary">
          还没有定时任务。它适合那种「隔一阵子就该做一次」的活 ——
          整理日志、拉取一遍状态、把某个目录的变化汇总一下。
        </p>
      ) : (
        <ul className="flex flex-col gap-2 py-2">
          {items.map((item) => (
            <ScheduleItemRow
              key={item.id}
              item={item}
              info={scheduleGrantInfo(snapshot, item.grant)}
              running={snapshot.running.includes(item.id)}
              busy={busyId === item.id}
              onToggle={(next) => void handleToggle(item, next)}
              onRunNow={() => void handleRunNow(item)}
              onEdit={() => {
                setCreating(false)
                setEditing(item)
              }}
              onRemove={() => handleRemove(item)}
            />
          ))}
        </ul>
      )}

      {creating || editing ? (
        <ScheduleForm
          /* key 变化就重挂表单 —— 换一条编辑时清掉上一条的草稿 */
          key={editing?.id ?? 'new'}
          initial={editing}
          snapshot={snapshot}
          minIntervalMinutes={snapshot?.minIntervalMinutes ?? 5}
          onSave={handleSave}
          onCancel={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      ) : (
        <Row label="新的定时任务" hint="名字、时间、提示词、授权上限 —— 建完可以随时改">
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={13} />}
              onClick={() => setCreating(true)}
            >
              新建
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={13} />}
              onClick={() => void refresh()}
            >
              刷新
            </Button>
          </div>
        </Row>
      )}
    </div>
  )
}

/** 顶上那三句实话（就放在这儿，别处不要再写一份） */
function ScheduleTruths() {
  return (
    <ul className="flex flex-col gap-1 py-2">
      {TRUTHS.map((text) => (
        <li
          key={text}
          className="flex items-start gap-1.5 text-dense leading-relaxed text-fg-secondary"
        >
          <CalendarClock size={11} className="mt-0.5 shrink-0 text-fg-tertiary" />
          <span>{text}</span>
        </li>
      ))}
    </ul>
  )
}
