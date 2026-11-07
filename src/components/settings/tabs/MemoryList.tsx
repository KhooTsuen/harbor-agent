import { useCallback, useEffect, useState } from 'react'
import { Ban, Check, Plus, RotateCcw, Search, Trash2 } from 'lucide-react'
import type { MemoryItem } from '@/types/backend'
import {
  memoryAdd,
  memoryDisable,
  memoryEnable,
  memoryList,
  memoryRemove,
  memorySearch,
  memorySupported,
} from '@/lib/memoryApi'
import { Button } from '@/components/ui/Button'
import { useUIStore } from '@/stores/useUIStore'
import { colorOf } from '@/lib/statusLanguage'
import { SCOPE_LABEL, SOURCE_LABEL, TYPE_LABEL, enableLabel } from './memoryLabels'

/* ══════════════════════════════════════════════════════════════
   记忆列表（含搜索、手动添加、逐条停用/删除）

   从 `MemoryTab.tsx` 抽出来的：那边 298 行贴顶，而第二阶段要重排这一页的
   信息层级（说明上移、列表独立成块），必须先把它单独放一个文件。

   ★ 数据读法没变：`memoryList` / `memorySearch` 走同一套 IPC，
     停用/删除后统一 `refresh()` —— 不给列表和页面各留一份状态。
   ══════════════════════════════════════════════════════════════ */

export function MemoryList({
  projectId,
  showSuperseded,
  onSupersededChange,
}: {
  projectId: string
  showSuperseded: boolean
  onSupersededChange: (next: boolean) => void
}): React.ReactElement {
  const showToast = useUIStore((s) => s.showToast)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [memoryScope, setMemoryScope] = useState<'global' | 'project'>('global')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!memorySupported()) return
    setBusy(true)
    setItems(await memoryList({ includeSuperseded: showSuperseded, projectId }))
    setBusy(false)
  }, [projectId, showSuperseded])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function search(text: string): Promise<void> {
    setQuery(text)
    if (!memorySupported()) return
    if (!text.trim()) {
      void refresh()
      return
    }
    setItems(await memorySearch(text, { projectId, includeSuperseded: showSuperseded }))
  }

  async function add(): Promise<void> {
    const content = draft.trim()
    if (!content) return
    const result = await memoryAdd({
      content,
      type: 'fact',
      source: 'user_explicit',
      scope: memoryScope,
      ...(memoryScope === 'project' && projectId ? { projectId } : {}),
    })
    if (!result.ok) {
      showToast('error', '没记下来', result.error)
      return
    }
    setDraft('')
    showToast('success', result.deduped ? '这条已经记过了' : '记住了', content.slice(0, 40))
    void refresh()
  }

  async function toggle(item: MemoryItem): Promise<void> {
    /* AG-032：开关状态只有一个字的差别，不点回去看不出来改了没 */
    const disabling = item.status === 'active'
    if (disabling) await memoryDisable(item.id)
    else await memoryEnable(item.id)
    showToast(
      'success',
      disabling ? '已停用' : `已${enableLabel(item.status)}`,
      item.content.slice(0, 40),
    )
    void refresh()
  }

  async function remove(item: MemoryItem): Promise<void> {
    await memoryRemove(item.id)
    showToast('success', '已删除', item.content.slice(0, 40))
    void refresh()
  }

  return (
    <>
      {/* 工具条：搜索 + 筛选 + 刷新 —— 独立一块板，不和数据行混排 */}
      <div className="acrylic-card flex flex-wrap items-center gap-2">
        <div className="flex min-w-[12rem] flex-1 items-center gap-1.5 rounded-sm border border-line-subtle bg-bg-input px-2 py-1.5">
          <Search size={13} className="shrink-0 text-fg-secondary" />
          <input
            value={query}
            onChange={(e) => void search(e.target.value)}
            placeholder="搜索记忆内容"
            className="min-w-0 flex-1 bg-transparent text-dense text-fg-primary placeholder:text-fg-secondary focus:outline-none"
          />
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-dense text-fg-secondary">
          <input
            type="checkbox"
            checked={showSuperseded}
            onChange={(e) => onSupersededChange(e.target.checked)}
          />
          含已被取代的
        </label>
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCcw size={12} />}
          onClick={() => void refresh()}
        >
          刷新
        </Button>
      </div>

      {/* 手动添加：一条输入 + 归属选择 + 记住 */}
      <div className="acrylic-card flex flex-wrap items-start gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          placeholder="手动加一条，例如：回答用简体中文，代码注释也用中文"
          className="min-w-[14rem] flex-1 rounded-sm border border-line-subtle bg-bg-input px-2 py-1.5 text-dense text-fg-primary placeholder:text-fg-secondary focus:border-line-focus focus:outline-none"
        />
        <select
          value={memoryScope}
          onChange={(e) => setMemoryScope(e.target.value as 'global' | 'project')}
          className="rounded-sm border border-line-subtle bg-bg-input px-2 py-1.5 text-dense text-fg-primary focus:outline-none"
          disabled={memoryScope === 'project' && !projectId}
          aria-label="记忆归属"
        >
          <option value="global">全局记忆</option>
          <option value="project">当前项目</option>
        </select>
        <Button variant="secondary" size="sm" icon={<Plus size={12} />} onClick={() => void add()}>
          记住
        </Button>
      </div>

      {busy && items.length === 0 ? (
        <p className="px-1 py-3 text-dense text-fg-secondary">读取中…</p>
      ) : items.length === 0 ? (
        <p className="px-1 py-3 text-dense text-fg-secondary">
          还没有记忆。说「记住……」或者在上面手动加一条。
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="acrylic-card flex flex-wrap items-start gap-2"
              style={{ opacity: item.status === 'active' ? 1 : 0.55 }}
            >
              <div className="min-w-[14rem] flex-1">
                <p className="break-words text-dense leading-relaxed text-fg-primary">
                  {item.content}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-secondary">
                  <span>{TYPE_LABEL[item.type] ?? item.type}</span>
                  <span>·</span>
                  <span>{SCOPE_LABEL[item.scope] ?? item.scope}</span>
                  <span>·</span>
                  <span>{SOURCE_LABEL[item.source] ?? item.source}</span>
                  <span>·</span>
                  <span>{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span>
                  {item.status === 'disabled' ? (
                    <span style={{ color: colorOf('warning') }}>已停用</span>
                  ) : null}
                  {item.status === 'superseded' ? <span>已被新的取代</span> : null}
                  {/* 过期既不是「你关的」也不是「被取代」：它自己到期了，颜色走中性的已取消灰 */}
                  {item.status === 'expired' ? (
                    <span style={{ color: colorOf('cancelled') }}>已过期</span>
                  ) : null}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={item.status === 'active' ? <Ban size={12} /> : <Check size={12} />}
                  onClick={() => void toggle(item)}
                >
                  {item.status === 'active' ? '停用' : enableLabel(item.status)}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={12} />}
                  onClick={() => void remove(item)}
                >
                  删除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
