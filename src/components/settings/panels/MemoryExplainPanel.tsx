import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { colorOf } from '@/lib/statusLanguage'
import {
  fetchMemoryExplain,
  memoryExplainBridgeReady,
  type MemoryExplainView,
  type MemoryScoreEntry,
} from '@/lib/memoryExplainApi'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 记忆 → 记忆是怎么挑的

   记忆检索一直在算一个分数并按它排序，但**分数和理由哪儿都不落** ——
   用户看到「注入了 5 条」，不知道凭什么是这 5 条，也不知道另外那些
   为什么没进来。这一块把内核的账摊开：上一轮真注入了哪几条、各多少分、
   分是怎么来的；现在这批里谁排前面、为什么。

   三件不许含糊的事：

   ① 注入账是**进程内**状态、不落盘。刚启动时它是 null —— 界面必须能
      显示「还没跑过对话」，不能假设它一定有值。
   ② 「现在这批」的解释和「上一轮真的注入了谁」是两件事：一边是当前
      active 记忆的实时打分，一边是历史账。标题分开写，别让用户混起来。
   ③ 权重只在内核（`electron/core/memory-explain.cjs`）。这里只说分数由
      哪几项组成，**不写任何权重数字** —— 复制一份数字就会和内核算的分对不上。
   ══════════════════════════════════════════════════════════════ */

/** 内容太长会把一行撑爆；注入账里内核已经截到 60 字，这里统一再兜一道 */
const CLIP = 80

function clip(text: string): string {
  return text.length > CLIP ? `${text.slice(0, CLIP)}…` : text
}

function timeOf(at: number): string {
  if (!at) return ''
  return new Date(at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function MemoryExplainPanel({ projectId }: { projectId: string }) {
  const ready = memoryExplainBridgeReady()

  const [view, setView] = useState<MemoryExplainView | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (text: string) => {
      setBusy(true)
      setView(await fetchMemoryExplain({ query: text, projectId }))
      setBusy(false)
    },
    [projectId],
  )

  /* 初次不带提问读一遍；换项目时 load 会变（依赖里是 projectId）→ 自动重读 */
  useEffect(() => {
    void load('')
  }, [load])

  if (!ready) {
    return (
      <>
        <SectionTitle>记忆是怎么挑的</SectionTitle>
        <p className="px-2 py-1 text-2xs text-fg-tertiary">
          当前版本没接上这个桥（memory:explain），所以看不到打分和理由 ——
          记忆本身的增删停用不受影响。
        </p>
      </>
    )
  }

  const injected = view?.injected ?? null
  const items = view?.items ?? []
  const retrieveEnabled = view?.retrieveEnabled ?? true

  return (
    <>
      <SectionTitle>上一轮注入了什么</SectionTitle>

      {injected ? (
        <>
          <p className="px-2 text-2xs text-fg-secondary">
            注入了 {injected.injected.length} 条 / 本轮上限 {injected.budget} 条，当时共有{' '}
            {injected.total} 条可用
            {injected.at ? `（${timeOf(injected.at)}）` : ''}。
          </p>
          {injected.injected.length === 0 ? (
            <p className="px-2 py-1 text-2xs text-fg-tertiary">
              上一轮一条都没进来 —— 当时可能还没有记忆，或者这次对话根本没带提问。
            </p>
          ) : (
            <ul className="flex flex-col gap-1 py-1">
              {injected.injected.map((entry) => (
                <ScoreRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="px-2 py-1 text-2xs leading-relaxed text-fg-tertiary">
          这次启动后还没跑过对话，所以还没有注入记录。这本账是进程内的、不落盘，
          重启就清空 —— 跑一轮对话再回来看这里。
        </p>
      )}

      <SectionTitle>现在这批为什么会 / 不会被选中</SectionTitle>

      {!retrieveEnabled ? (
        <p className="-mt-1 mb-1 flex gap-1.5 rounded-base border border-line-subtle px-3 py-2 text-2xs leading-relaxed text-fg-secondary">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" style={{ color: colorOf('warning') }} />
          <span>
            检索关了，现在是<strong className="text-fg-primary">全量注入</strong>
            ，所以没有排序和理由 —— 条数多了会稀释上下文。
            （这一档没有界面开关，在 config.json 的 memory.retrieve。）
          </span>
        </p>
      ) : (
        <>
          <Row
            label="试算一句提问"
            hint="看这句话会让哪些记忆排上来。只算分，不改任何东西。"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void load(query)
                }}
                placeholder="例如：这次改动的接口要兼容旧版本吗"
                spellCheck={false}
                className="w-full min-w-0 rounded-sm border border-line-subtle bg-bg-raised px-2 py-1.5 text-dense text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
              />
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                onClick={() => void load(query)}
              >
                试算
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={12} />}
                disabled={busy}
                onClick={() => void load('')}
              >
                清空提问
              </Button>
            </div>
          </Row>

          {items.length === 0 ? (
            <p className="px-2 py-1 text-2xs text-fg-tertiary">
              没有生效中的记忆，所以没东西可挑。去上面的列表里加一条。
            </p>
          ) : (
            <ul className="flex flex-col gap-1 py-1">
              {items.map((entry) => (
                <ScoreRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}

          <p className="px-1 text-2xs leading-relaxed text-fg-tertiary">
            分数高的排在上面。条数没超过上限时内核其实是<strong className="text-fg-secondary">全量注入</strong>
            （顺序按最近更新在前）—— 那时分数只是算给你看，没参与挑选。
          </p>
        </>
      )}

      <p className="pt-3 text-2xs leading-relaxed text-fg-tertiary">
        分数由这几项加起来：范围 + 类型 + 重要度 + 可信度 + 新鲜度 + 与本次提问的重合度。
        具体权重只在内核（electron/core/memory-explain.cjs），这里不复制一份数字 ——
        复制了就会和内核算出来的分对不上。
      </p>
    </>
  )
}

/** 一条解释：内容（截断）+ 分数 + 内核给的中文理由 */
function ScoreRow({ entry }: { entry: MemoryScoreEntry }) {
  const tag = `${entry.type || '未分类'} · ${entry.scope || '范围没写'}`
  return (
    <li className="rounded-sm border border-line-hairline bg-bg-raised/30 px-2 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 break-words text-dense text-fg-primary">
          {clip(entry.content)}
        </span>
        <span className="shrink-0 font-mono text-2xs text-fg-secondary">
          分数 {entry.score.toFixed(1)}
        </span>
      </div>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-fg-tertiary">
        <span>{tag}</span>
        <span>{entry.reason || '内核没给理由'}</span>
      </p>
    </li>
  )
}
