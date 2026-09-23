import { useState } from 'react'
import {
  scheduleDraftError,
  type ScheduleDraft,
  type ScheduleGrantId,
  type ScheduleItem,
  type ScheduleListSnapshot,
  type ScheduleWhen,
} from '@/lib/schedulesApi'
import { Button } from '@/components/ui/Button'
import { Field, Select } from '@/components/ui/Field'
import { Row, SectionTitle } from '../parts'
import { GrantPicker } from './GrantPicker'

/* ══════════════════════════════════════════════════════════════
   新建 / 编辑定时任务

   两条规矩：
     ① 客户端只挡「一眼就看得出来白填」的（名字空、提示词空、间隔太小）——
        真正的校验在内核（它还会拒收含密钥的提示词，那一套前端复刻不了）。
        内核返回 ok:false 时，把它的 error **原样**显示，不翻译、不概括。
     ② 新建时授权档默认落在**最严的 readonly**：默认值就是一串权限，
        给宽了用户不会回头改。

   时间用两个原生控件（数字 + time）而不是自己搓输入框：
   `type="time"` 产出的就是 HH:MM，正好是内核要的格式，也省得自己校验位数。
   ══════════════════════════════════════════════════════════════ */

const WHEN_OPTIONS = [
  { value: 'interval', label: '每隔一段时间' },
  { value: 'daily', label: '每天某个钟点' },
] as const

export function ScheduleForm({
  initial,
  snapshot,
  minIntervalMinutes,
  onSave,
  onCancel,
}: {
  /** 有值 = 编辑这一条；null = 新建 */
  initial: ScheduleItem | null
  /** 只为拿三档说明（内核原文），列表没取到就是 null */
  snapshot: ScheduleListSnapshot | null
  minIntervalMinutes: number
  onSave: (draft: ScheduleDraft) => Promise<{ ok: boolean; error?: string }>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [mode, setMode] = useState<'interval' | 'daily'>(initial?.when.type ?? 'interval')
  const [minutes, setMinutes] = useState(
    initial?.when.type === 'interval' ? String(initial.when.minutes) : '30',
  )
  const [at, setAt] = useState(initial?.when.type === 'daily' ? initial.when.at : '09:30')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [workdir, setWorkdir] = useState(initial?.workdir ?? '')
  /* 默认最严的一档：新建时不预选一个「宽松」的，用户就不会稀里糊涂用了它 */
  const [grant, setGrant] = useState<ScheduleGrantId>(initial?.grant ?? 'readonly')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  function whenOf(): ScheduleWhen {
    if (mode === 'interval') return { type: 'interval', minutes: Number(minutes) }
    return { type: 'daily', at }
  }

  async function submit(): Promise<void> {
    /*
     * id 只在编辑时带上：内核「带了找不到的 id」会报错而不是静默新建，
     * 这是为了拦住「拿旧列表去存」的情况 —— 所以别在这儿硬塞一个空 id。
     */
    const draft: ScheduleDraft = {
      ...(initial ? { id: initial.id } : {}),
      name,
      when: whenOf(),
      prompt,
      workdir,
      grant,
    }

    const local = scheduleDraftError(draft, minIntervalMinutes)
    if (local) {
      setError(local)
      return
    }

    setSaving(true)
    const result = await onSave(draft)
    setSaving(false)
    /* 失败原因以内核为准（它比前端知道得多），原样显示 */
    if (!result.ok) setError(result.error ?? '保存失败，内核没给出原因')
  }

  return (
    <div className="flex flex-col gap-1.5">
      <SectionTitle>{initial ? `编辑「${initial.name}」` : '新建定时任务'}</SectionTitle>

      <Row label="名字" hint="给它起个一眼能认出来的名字，任务台账和会话都用它">
        <Field
          value={name}
          onChange={setName}
          aria-label="定时任务名字"
          placeholder="比如：每天整理一下昨天的日志"
        />
      </Row>

      <Row
        label="时间"
        hint={`最小间隔 ${minIntervalMinutes} 分钟。本地时间，跟着你电脑的钟走`}
      >
        <div className="flex w-full items-center gap-2">
          <Select
            value={mode}
            options={WHEN_OPTIONS}
            aria-label="时间类型"
            className="w-40 shrink-0"
            onChange={(next) => setMode(next === 'daily' ? 'daily' : 'interval')}
          />
          {mode === 'interval' ? (
            <Field
              type="number"
              min={1}
              value={minutes}
              onChange={setMinutes}
              aria-label="间隔分钟数"
              placeholder="分钟"
              className="w-28 shrink-0"
            />
          ) : (
            <Field
              type="time"
              value={at}
              onChange={setAt}
              aria-label="每天的钟点"
              className="w-32 shrink-0"
            />
          )}
        </div>
      </Row>

      <Row
        label="提示词"
        hint="每次跑都是把这段话当成一条消息发给模型 —— 写清楚「做什么、做完算什么」，别写「看着办」"
      >
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={6}
          aria-label="定时任务提示词"
          placeholder="比如：检查 data/logs 里昨天的日志，把报错行汇总成一段话，写进 data/artifacts/。"
          className="w-full resize-y rounded-sm border border-line-subtle bg-bg-raised px-2.5 py-2 text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
        />
      </Row>

      <Row label="工作目录" hint="留空 = 用默认工作目录。填了但目录不存在，内核会按留空处理">
        <Field
          value={workdir}
          onChange={setWorkdir}
          aria-label="工作目录"
          placeholder="留空即可"
        />
      </Row>

      <div className="flex flex-col gap-1.5">
        <p className="text-dense text-fg-primary">
          授权上限
          <span className="ml-2 text-2xs font-normal text-fg-tertiary">
            没人在场，所以这一档就是它能碰到的天花板
          </span>
        </p>
        <GrantPicker value={grant} snapshot={snapshot} onChange={setGrant} />
      </div>

      {error ? (
        <p className="rounded-base border border-[color-mix(in_srgb,var(--error)_40%,transparent)] px-3 py-2 text-2xs leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" loading={saving} onClick={() => void submit()}>
          {initial ? '保存修改' : '创建'}
        </Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          取消
        </Button>
        <span className="text-2xs text-fg-tertiary">
          保存时内核会再校验一遍 —— 提示词里混了密钥这类情况由它拒收。
        </span>
      </div>
    </div>
  )
}
