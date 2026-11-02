import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Pencil, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react'
import type { ExperienceItem, ExperienceStats } from '@/types/experience'
import { useUIStore } from '@/stores/useUIStore'
import { experienceList, experienceReview, experienceSupported } from '@/lib/experienceApi'
import { Button } from '@/components/ui/Button'
import { Row, SectionTitle } from '../parts'
import { colorOf } from '@/lib/statusLanguage'
import {
  FILTERS,
  STATUS_COLOR,
  metaOf,
  needsDraftInput,
  type Filter,
} from '@/lib/experienceDisplay'

/* ══════════════════════════════════════════════════════════════
   设置 → 经验与规则（自我纠错闭环的**审批档位**）

   为什么要有这一页：系统在真跑里学到的「这样会失败、换那样就好了」，
   只有**独立验证过**才被注入。剩下三类永远升不上去（用户纠正 /
   权限与外部阻塞 / 高风险），此前它们只能烂在库里 —— 而它们恰恰最值得记。
   这一页就是那道门：人看一条，判它能不能变成建议。

   刻意做成**列表 + 逐条动作**，不是「全部批准」：
     · 每条都带着它凭什么在这儿（原因码 / 目标 / 验证次数 / 反例证据）；
     · 批准要有一条**能注入的做法**（系统记下的那次成功，或手写一句）。
       没有就不许批 —— 批一条「遇到过 X，但不知道怎么办」进提示没有意义。
     · 批完能**改做法**（`amend`）：只换那句话，不动状态 ——
       否则措辞不清楚就只能驳回，而驳回是终点（等于逼人做更大的决定）。
   ══════════════════════════════════════════════════════════════ */

/** 类别筛选：`category` 以前只写不读（库里有、界面看不见） */
const CATEGORY_LABEL: Record<string, string> = {
  tool_failure: '工具失败',
  assertion_failed: '断言失败',
  user_correction: '用户纠正',
  permission: '权限挡住',
  external_blocked: '外部阻塞',
}

const CATEGORY_FILTERS = Object.keys(CATEGORY_LABEL)

export function ExperienceTab() {
  const showToast = useUIStore((s) => s.showToast)
  const [items, setItems] = useState<ExperienceItem[]>([])
  const [stats, setStats] = useState<ExperienceStats>({ total: 0, byStatus: {}, verified: 0 })
  const [filter, setFilter] = useState<Filter>('pending')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  /* 批准 / 改做法时手写的那句「该怎么做」：按 id 存 */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /* 哪几条被点开了「改做法」 */
  const [editing, setEditing] = useState<Record<string, boolean>>({})

  const refresh = useCallback(async () => {
    if (!experienceSupported()) return
    setBusy(true)
    /* 管理视图连「已驳回」一起要：这一页要能回答「我上次驳回过什么」 */
    const result = await experienceList({ includeClosed: true })
    setItems(result.items)
    setStats(result.stats)
    setBusy(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function act(item: ExperienceItem, action: 'approve' | 'reject' | 'restore' | 'amend') {
    const result = await experienceReview({
      id: item.id,
      action,
      actionText: drafts[item.id] ?? '',
    })
    if (!result.ok) {
      /*
       * `needs_action` 是**正常**情形，不是报错：这条没有做法，得先填一句。
       * 用 warn 而不是 error，文案直接说「要怎么做」。
       */
      showToast(result.reason === 'needs_action' ? 'warning' : 'error', '没批成', result.error)
      return
    }
    const done =
      action === 'reject'
        ? '已驳回'
        : action === 'restore'
          ? '已恢复'
          : action === 'amend'
            ? '做法已改'
            : '已批准'
    showToast('success', done, item.triggerText.slice(0, 40))
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[item.id]
      return next
    })
    setEditing((prev) => ({ ...prev, [item.id]: false }))
    void refresh()
  }

  if (!experienceSupported()) {
    return <p className="p-3 text-dense text-fg-tertiary">经验列表需要桌面版。</p>
  }

  const shown = items.filter((item) => {
    if (category && item.category !== category) return false
    if (filter === 'all') return true
    if (filter === 'pending') return item.pending
    return item.status === filter
  })

  return (
    <div className="flex flex-col gap-2 pb-6">
      <SectionTitle>自我纠错</SectionTitle>
      <p className="px-2 py-1 text-dense text-fg-tertiary">
        系统在真实执行里观察到的失败，只有**独立验证过**才会变成建议。
        这里能让人批准、驳回、改做法，或把被反例打停的经验恢复回来。 库容量上限 200
        条，超出时先清最旧的已驳回条目。
      </p>

      <Row label="现在库里有" hint="待处理 = 还没被验证通过、也没被驳回的；生效中 = 会进每轮提示。">
        <span className="font-mono text-dense text-fg-secondary">
          共 {stats.total} 条 · 待处理 {stats.byStatus.candidate ?? 0} · 生效中{' '}
          {stats.byStatus.verified ?? 0} · 已停止 {stats.byStatus.suspended ?? 0}
        </span>
      </Row>

      <div className="flex items-center gap-1.5 py-2">
        {FILTERS.map((entry) => (
          <Button
            key={entry.id}
            variant={filter === entry.id ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFilter(entry.id)}
            aria-label={`筛选：${entry.label}`}
          >
            {entry.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCcw size={12} />}
          onClick={() => void refresh()}
        >
          刷新
        </Button>
      </div>

      {/* 类别筛选：`category` 以前只写进库、界面完全看不到 */}
      <div className="flex flex-wrap items-center gap-1.5 pb-2">
        <span className="text-2xs text-fg-tertiary">类别</span>
        <Button
          variant={category === '' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setCategory('')}
          aria-label="筛选类别：全部"
        >
          全部
        </Button>
        {CATEGORY_FILTERS.map((id) => (
          <Button
            key={id}
            variant={category === id ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setCategory(id)}
            aria-label={`筛选类别：${CATEGORY_LABEL[id]}`}
          >
            {CATEGORY_LABEL[id]}
          </Button>
        ))}
      </div>

      {busy && shown.length === 0 ? (
        <p className="py-2 text-dense text-fg-tertiary">读取中…</p>
      ) : shown.length === 0 ? (
        <p className="py-2 text-dense text-fg-tertiary">
          {filter === 'pending'
            ? '没有待处理的。跑任务时真失败了，这里会出现一条候选（不会直接变成规则）。'
            : '这一类现在是空的。'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-1.5 rounded-sm border border-line-hairline bg-bg-raised/30 px-2 py-1.5"
              data-experience-id={item.id}
              data-experience-status={item.status}
              data-experience-category={item.category}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-dense text-fg-primary">{item.triggerText}</p>
                  {item.recommendedAction ? (
                    <p className="mt-0.5 break-words text-2xs text-fg-secondary">
                      做法：{item.recommendedAction}
                    </p>
                  ) : null}
                  {item.causeHypothesis ? (
                    <p className="mt-0.5 break-words text-2xs text-fg-tertiary">
                      原因假设：{item.causeHypothesis}
                    </p>
                  ) : null}
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-fg-tertiary">
                    {metaOf(item).map((bit) => (
                      <span key={bit}>{bit}</span>
                    ))}
                    <span style={{ color: colorOf(STATUS_COLOR[item.status]) }}>
                      {item.injectable ? '会进提示' : '不进提示'}
                    </span>
                    <span>{item.target || '（没有目标）'}</span>
                  </p>
                </div>
              </div>

              {/* 没有系统做法时批准必须先写一句；点了「改做法」也复用这个输入框 */}
              {needsDraftInput(item, editing[item.id] === true) ? (
                <input
                  value={drafts[item.id] ?? (editing[item.id] ? item.recommendedAction : '')}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  placeholder="这次该怎么做？批准前必须写一句（会进提示）"
                  aria-label="批准时使用的做法"
                  className="w-full rounded-sm border border-line-subtle bg-bg-input px-2 py-1 text-dense text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
                />
              ) : null}

              <div className="flex items-center gap-1.5">
                {item.status === 'candidate' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ShieldCheck size={12} />}
                    onClick={() => void act(item, 'approve')}
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
                    onClick={() => void act(item, 'restore')}
                    aria-label="恢复这条经验"
                  >
                    恢复
                  </Button>
                ) : null}
                {item.recommendedAction &&
                item.status !== 'rejected' &&
                item.status !== 'deprecated' ? (
                  editing[item.id] ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Pencil size={12} />}
                      onClick={() => void act(item, 'amend')}
                      aria-label="保存修改后的做法"
                    >
                      保存
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Pencil size={12} />}
                      onClick={() => setEditing((prev) => ({ ...prev, [item.id]: true }))}
                      aria-label="修改这条经验的做法"
                    >
                      改做法
                    </Button>
                  )
                ) : null}
                {item.status !== 'rejected' && item.status !== 'deprecated' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={12} />}
                    onClick={() => void act(item, 'reject')}
                    aria-label="驳回这条经验"
                  >
                    驳回
                  </Button>
                ) : null}
                {item.blockedReason ? (
                  <span className="text-2xs text-fg-tertiary">{item.blockedReason}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
