import { useCallback, useEffect, useState } from 'react'
import { Ban, Check, Plus, RotateCcw, Search, Trash2 } from 'lucide-react'
import type { MemoryItem } from '@/types/backend'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
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
import { Row, SectionTitle } from '../parts'
import { MemoryExplainPanel } from '../panels/MemoryExplainPanel'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   设置 → 记忆

   刻意做成**列表**而不是一个文本框：记忆是长期攒下来的东西，
   用户需要能一条条看清「它记住了什么、哪来的、什么时候记的」，
   并且能单独停用一条 —— 改一个字就整套重写的文本框做不到这些。

   每条都显示来源：
     · 你明说的         → 直接生效
     · 你确认过的       → 直接生效
     · 模型建议被采纳的 → 直接生效
     · 从旧版本导入的   → 需要你过一眼
   ══════════════════════════════════════════════════════════════ */

const TYPE_LABEL: Record<MemoryItem['type'], string> = {
  preference: '偏好',
  fact: '事实',
  workflow: '流程',
  project_rule: '项目规则',
  constraint: '约束',
  decision: '已定方案',
  temporary: '临时',
  habit: '习惯',
  instruction: '要求',
}

const SOURCE_LABEL: Record<MemoryItem['source'], string> = {
  user_explicit: '你说的',
  user_confirmed: '你确认的',
  model_suggested: '模型建议',
  imported: '旧版本导入',
  system: '系统',
}

const SCOPE_LABEL: Record<MemoryItem['scope'], string> = {
  global: '全局',
  project: '项目',
  workspace: '工作目录',
  task: '任务',
  session: '本次会话',
}

export function MemoryTab() {
  const config = useConfigStore((s) => s.config)
  const patchMemory = useConfigStore((s) => s.patchMemory)
  const showToast = useUIStore((s) => s.showToast)
  const projectId = useAppStore((s) => s.activeProjectId)
  const project = useAppStore((s) => s.projects.find((item) => item.id === projectId))

  const [items, setItems] = useState<MemoryItem[]>([])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [showSuperseded, setShowSuperseded] = useState(false)
  const [memoryScope, setMemoryScope] = useState<'global' | 'project'>('global')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
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
    showToast('success', disabling ? '已停用' : '已启用', item.content.slice(0, 40))
    void refresh()
  }

  async function remove(item: MemoryItem): Promise<void> {
    await memoryRemove(item.id)
    showToast('success', '已删除', item.content.slice(0, 40))
    void refresh()
  }

  /*
   * 浏览器预览没有桥。记忆列表要整块干掉，但「记忆是怎么挑的」自己会说
   * 「桥没接上」，留着它比整页空白有用。
   */
  if (!memorySupported()) {
    return (
      <div className="flex flex-col gap-2 pb-6">
        <MemoryExplainPanel projectId={projectId} />
        <p className="p-3 text-dense text-fg-tertiary">记忆列表需要桌面版。</p>
      </div>
    )
  }

  const memory = config?.memory

  return (
    <div className="flex flex-col gap-2 pb-6">
      <SectionTitle>当前项目</SectionTitle>
      <p className="px-2 py-1 text-dense text-fg-tertiary">
        {project
          ? `项目记忆会绑定到「${project.name}」，其他项目不会注入。`
          : '当前没有选中的项目。项目记忆需要先选择工作目录。'}
      </p>

      <Row label="模型想记东西时" hint="记忆会影响之后所有对话，记错一条比改错一个文件影响更久。">
        <select
          value={memory?.autoWrite ?? 'ask'}
          onChange={(e) =>
            void patchMemory({ autoWrite: e.target.value as 'auto' | 'ask' | 'off' })
          }
          className="rounded-sm border border-line-subtle bg-bg-raised px-2 py-1 text-dense text-fg-primary focus:outline-none"
        >
          <option value="ask">先问我（推荐）</option>
          <option value="auto">让它自己记</option>
          <option value="off">不许写，只读</option>
        </select>
      </Row>
      <Row label="每轮注入几条" hint="按相关性挑，不是全塞。多了会稀释注意力、还烧 token。">
        <input
          type="number"
          min={1}
          max={50}
          value={memory?.injectLimit ?? 12}
          onChange={(e) => void patchMemory({ injectLimit: Number(e.target.value) || 12 })}
          className="w-20 rounded-sm border border-line-subtle bg-bg-raised px-2 py-1 font-mono text-dense text-fg-primary focus:outline-none"
        />
      </Row>

      <SectionTitle>记忆列表</SectionTitle>

      <div className="flex items-center gap-2 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm border border-line-subtle bg-bg-raised px-2 py-1.5">
          <Search size={13} className="shrink-0 text-fg-tertiary" />
          <input
            value={query}
            onChange={(e) => void search(e.target.value)}
            placeholder="搜索记忆内容"
            className="min-w-0 flex-1 bg-transparent text-dense text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
          />
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-dense text-fg-secondary">
          <input
            type="checkbox"
            checked={showSuperseded}
            onChange={(e) => setShowSuperseded(e.target.checked)}
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

      <div className="flex items-start gap-2 pb-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          placeholder="手动加一条，例如：回答用简体中文，代码注释也用中文"
          className="min-w-0 flex-1 rounded-sm border border-line-subtle bg-bg-raised px-2 py-1.5 text-dense text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
        />
        <select
          value={memoryScope}
          onChange={(e) => setMemoryScope(e.target.value as 'global' | 'project')}
          className="rounded-sm border border-line-subtle bg-bg-raised px-2 py-1 text-dense text-fg-primary focus:outline-none"
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
        <p className="py-2 text-dense text-fg-tertiary">读取中…</p>
      ) : items.length === 0 ? (
        <p className="py-2 text-dense text-fg-tertiary">
          还没有记忆。说「记住……」或者在上面手动加一条。
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-2 rounded-sm border border-line-hairline bg-bg-raised/30 px-2 py-1.5"
              style={{ opacity: item.status === 'active' ? 1 : 0.5 }}
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-dense text-fg-primary">{item.content}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-fg-tertiary">
                  <span>{TYPE_LABEL[item.type] ?? item.type}</span>
                  <span>{SCOPE_LABEL[item.scope] ?? item.scope}</span>
                  <span>{SOURCE_LABEL[item.source] ?? item.source}</span>
                  <span>{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span>
                  {item.status === 'disabled' ? (
                    <span style={{ color: colorOf('warning') }}>已停用</span>
                  ) : null}
                  {item.status === 'superseded' ? <span>已被新的取代</span> : null}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                icon={item.status === 'active' ? <Ban size={12} /> : <Check size={12} />}
                onClick={() => void toggle(item)}
              >
                {item.status === 'active' ? '停用' : '启用'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={12} />}
                onClick={() => void remove(item)}
              >
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="pt-3 text-dense text-fg-tertiary">
        共 {items.length} 条（含已取代）。超过上限时会自动清理最旧的临时记忆。
      </p>

      <MemoryExplainPanel projectId={projectId} />
    </div>
  )
}
