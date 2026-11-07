import { useCallback, useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { ExperienceItem, ExperienceStats } from '@/types/experience'
import { useUIStore } from '@/stores/useUIStore'
import { experienceList, experienceReview, experienceSupported } from '@/lib/experienceApi'
import { Button } from '@/components/ui/Button'
import { Row, SectionTitle } from '../parts'
import { FILTERS, type Filter } from '@/lib/experienceDisplay'
import { ExperienceRow } from './ExperienceRow'

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

   ── 第二阶段：把「这三类分别是什么、为什么升不上去」写明白 ──────
   以前只在文件头注释里解释，界面上只有一句概括。用户进来第一反应是
   「这些跟『规则』有什么关系」，所以现在顶上先放一张三行说明表：

     候选（还没验证）→ 生效中（进每轮提示）→ 已停止（被反例打停）

   然后才是筛选和列表。列表项在 `ExperienceRow.tsx`（原文件 299 行贴顶）。
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

/** 三种状态各是什么意思 —— 用户进来最先要搞清的就是这个 */
const LIFECYCLE = [
  { key: '候选', text: '真跑里发现的一次失败，还没被独立验证。不会进提示，只在这儿等你判断。' },
  {
    key: '生效中',
    text: '验证过、或你亲手批准过。每轮会挑相关的几条注入提示 —— 这是它唯一的影响方式。',
  },
  { key: '已停止', text: '被后来的反例打停了。记录留着（能追查），但不再注入，可以手动恢复。' },
]

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

  /*
   * 浏览器预览没有经验通道 —— **只让列表消失**，说明和统计照旧。
   * 第二阶段修：以前整页提前 return 成一句话，说明文字（三种状态各是什么）
   * 在预览形态下完全看不到，而它是纯文本，没有理由依赖桌面桥。
   */
  const supported = experienceSupported()

  const shown = items.filter((item) => {
    if (category && item.category !== category) return false
    if (filter === 'all') return true
    if (filter === 'pending') return item.pending
    return item.status === filter
  })

  return (
    <>
      <SectionTitle hint="只有验证过的才会进提示 —— 这是它唯一的影响方式">
        它是怎么起作用的
      </SectionTitle>

      <div className="acrylic-card">
        <ul className="flex flex-col gap-2 text-dense leading-relaxed text-fg-secondary">
          {LIFECYCLE.map((row) => (
            <li key={row.key}>
              <span className="font-medium text-fg-primary">{row.key}：</span>
              {row.text}
            </li>
          ))}
        </ul>
      </div>

      <Row
        label="现在库里有"
        hint="待处理 = 还没被验证通过、也没被驳回的；生效中 = 会进每轮提示。库容量上限 200 条，超出时先清最旧的已驳回条目"
      >
        <span className="font-mono text-dense text-fg-secondary">
          共 {stats.total} 条 · 待处理 {stats.byStatus.candidate ?? 0} · 生效中{' '}
          {stats.byStatus.verified ?? 0} · 已停止 {stats.byStatus.suspended ?? 0}
        </span>
      </Row>

      <SectionTitle hint="按状态看；「类别」再按失败来源细分">筛选</SectionTitle>

      {/* 状态与类别两组按钮放同一块板里，中间用一条细线分开 */}
      <div className="acrylic-card flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-2xs text-fg-secondary">状态</span>
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
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line-hairline pt-2">
          <span className="mr-1 text-2xs text-fg-secondary">类别</span>
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
      </div>

      {!supported ? (
        <p className="px-1 py-3 text-dense text-fg-secondary">
          经验列表需要桌面版（浏览器预览里没有读取经验的通道）。
        </p>
      ) : busy && shown.length === 0 ? (
        <p className="px-1 py-3 text-dense text-fg-secondary">读取中…</p>
      ) : shown.length === 0 ? (
        <p className="px-1 py-3 text-dense text-fg-secondary">
          {filter === 'pending'
            ? '没有待处理的。跑任务时真失败了，这里会出现一条候选（不会直接变成规则）。'
            : '这一类现在是空的。'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((item) => (
            <ExperienceRow
              key={item.id}
              item={item}
              draft={drafts[item.id] ?? ''}
              onDraftChange={(value) => setDrafts((prev) => ({ ...prev, [item.id]: value }))}
              editing={editing[item.id] === true}
              onStartEdit={() => setEditing((prev) => ({ ...prev, [item.id]: true }))}
              onAct={(action) => void act(item, action)}
            />
          ))}
        </ul>
      )}
    </>
  )
}
