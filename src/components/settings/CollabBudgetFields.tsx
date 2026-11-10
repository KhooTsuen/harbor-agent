import { useEffect, useState } from 'react'
import type { CollabLimits } from '@/types/collab'

const fields = [
  { key: 'maxRounds', label: '执行与检查轮数', min: 1, max: 10 },
  { key: 'maxRuntime', label: '总时长（秒）', min: 60, max: 7200 },
  { key: 'maxTokens', label: '已报告 Token 上限', min: 0, max: Number.MAX_SAFE_INTEGER },
] as const
const draftOf = (limits: CollabLimits) => ({
  maxRounds: String(limits.maxRounds),
  maxRuntime: String(limits.maxRuntime),
  maxTokens: String(limits.maxTokens),
})

export function CollabBudgetFields({
  limits,
  disabled,
  onSave,
}: {
  limits: CollabLimits
  disabled: boolean
  onSave: (limits: CollabLimits) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(() => draftOf(limits))
  const [error, setError] = useState('')
  useEffect(() => {
    setDraft(draftOf(limits))
    setError('')
  }, [limits.maxRounds, limits.maxRuntime, limits.maxTokens])
  const dirty = fields.some(({ key }) => draft[key] !== String(limits[key]))

  const save = async (): Promise<void> => {
    const parsed = {
      maxRounds: Number(draft.maxRounds),
      maxRuntime: Number(draft.maxRuntime),
      maxTokens: Number(draft.maxTokens),
    }
    if (
      fields.some(
        ({ key, min, max }) =>
          !draft[key].trim() ||
          !Number.isSafeInteger(parsed[key]) ||
          parsed[key] < min ||
          parsed[key] > max,
      )
    ) {
      setError('请填写范围内的整数，Token 上限可以填 0。')
      return
    }
    setError('')
    if (await onSave(parsed)) setDraft(draftOf(parsed))
  }

  return (
    <form
      className="space-y-2 text-xs"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      {fields.map(({ key, label, min, max }) => (
        <label key={key} className="flex items-center justify-between gap-3">
          <span>{label}</span>
          <input
            type="number"
            min={min}
            max={max}
            step={1}
            required
            disabled={disabled}
            value={draft[key]}
            onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
            className="w-28 rounded-sm border border-line-subtle bg-bg-input px-2 py-1 text-fg-primary disabled:opacity-50"
          />
        </label>
      ))}
      <p className="text-fg-muted">
        Token 填 0
        表示不限。设置上限后，调用未提供用量会暂停协作；上限按已报告用量核对，轮数与总时长始终生效。
      </p>
      {error ? (
        <p role="alert" className="text-fg-danger">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={disabled || !dirty}
        className="rounded-sm border border-line-subtle px-2 py-1 hover:bg-bg-hover disabled:opacity-50"
      >
        {disabled ? '正在保存…' : '保存协作预算'}
      </button>
    </form>
  )
}
