import { AtSign, Slash } from 'lucide-react'

/* ══════════════════════════════════════════════════════════════
   输入框下面那行小字：工作目录 + 上下文用量 + 提文件/命令提示

   从 Composer.tsx 拆出来的（那边过 300 行了）。
   纯展示，不参与输入状态，拆开没有代价。
   ══════════════════════════════════════════════════════════════ */

import type { ThreadSettings } from '@/types'
import type { UiStatus } from '@/lib/statusLanguage'
import { colorOf } from '@/lib/statusLanguage'
import { Tooltip } from '@/components/ui/Tooltip'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { adviseCompact, DEFAULT_AUTO_RATIO, modelWindowOf } from '@/stores/thread/compact'
import { knownTotalsOf } from '@/types/usage'

/** 圈圈直径 / 描边（px）—— 2xs 的字号旁边，再大就抢眼了 */
const RING = 6
/** 环的周长（算 dash 用） */
const CIRC = 2 * Math.PI * RING

/**
 * 上下文用量圈（真机反馈 12c）。
 *
 * 口径与压缩完全同一份（`adviseCompact`）：如果这里和压缩各算各的，
 * 用户就会看到「圈才到 50%，它却自己压了」这种自相矛盾的事。
 *
 * 数据自己从 store 取，不让 Composer 多传三个 prop —— 那边贴着 300 行了。
 * 代价：消息每长一点就重算一次。这是纯长度估算（不序列化、不统计 token），
 * 上千条消息也就一次 reduce，可以接受。
 */
function ContextGauge() {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const cfg = useConfigStore((s) => s.config)
  if (!thread) return null

  const window = modelWindowOf(cfg?.capabilities, thread.model)
  const advice = adviseCompact(
    thread.messages,
    cfg?.context?.baseTokens ?? 0,
    { warn: cfg?.context?.compactAt, auto: cfg?.context?.autoCompactAt },
    window,
  )
  const pct = Math.max(0, Math.min(100, Math.round(advice.ratio * 100)))
  /* 颜色只从状态语言表取：过提醒线黄、过自动线红（那条线过了会真压） */
  const status: UiStatus = advice.auto ? 'failed' : advice.warn ? 'warning' : 'neutral'
  const color = colorOf(status)
  /*
   * Phase 7 二期：tooltip 再给几条**现成的**信息（都不碰内核）——
   *   · 缓存命中 token（`message.usage.cached`，命中部分便宜很多）；
   *   · 距自动压缩线还差多少（`autoCompactAt × 上限 − 已用`）；
   *   · P1-B 起多给**分项**：存了多少 / 准备发多少 / 工具占多少。
   *     为什么要有：以前只有一个数，用户看到「55% 却把历史裁没了」无从判断
   *     （那个数只算正文、不含工具记录，实测低估 2.3～6.3 倍）。
   * 口径与压缩同一份（`advice`），不自己另算一套。
   */
  /*
   * 缓存命中 token：**服务商上报的真实值**（`cached` 含在 `prompt` 内，不重复加）。
   * ★ 2026-11-09 修：以前读 `message.usage?.cached`，而落在这里的其实是原始字段
   *   （`prompt_cache_hit_tokens`）—— 于是这个数字**永远是 0**。
   *   现在内核在 `handlers/chat.cjs` 出口就归一成 `UsageBucket` 口径（见 `usage-bucket.cjs`）。
   */
  const knownSum = thread.messages.reduce(
    (acc, message) => {
      const one = knownTotalsOf(message.usage)
      return {
        prompt: acc.prompt + one.prompt,
        completion: acc.completion + one.completion,
        total: acc.total + one.total,
        cached: acc.cached + one.cached,
        requests: acc.requests + one.requests,
        unknown: acc.unknown + one.unknown,
      }
    },
    { prompt: 0, completion: 0, total: 0, cached: 0, requests: 0, unknown: 0 },
  )
  const cached = knownSum.cached
  /* 最近一次**有真实用量**的回复 —— 用于「最近一次请求」那一行 */
  const lastUsage = [...thread.messages].reverse().find((message) => message.usage?.known)?.usage
  /* 最近一条回复（不管有没有用量）—— 用来区分「统计中」和「没上报」 */
  const lastMessage = [...thread.messages]
    .reverse()
    .find((message) => message.kind !== 'error' && (message.role === 'assistant' || message.usage))
  const autoAt = Number.isFinite(cfg?.context?.autoCompactAt)
    ? Number(cfg?.context?.autoCompactAt)
    : DEFAULT_AUTO_RATIO
  const remain = Math.max(0, Math.round(autoAt * advice.limit - advice.used))
  const b = advice.breakdown
  /*
   * P1-B（2026-11-07 验收补）：内核这一轮**实际组装完**的量。
   *
   * `advice.used` 是「待组装的理论量」（压缩点之后全部消息展开），内核真正发出去的
   * 还要过字符额度裁剪。两者在没超预算时相等，超预算时差距很大（实测一份会话
   * 理论 912%、实际只用了对话层 30%）。只给理论量会让用户以为爆了 ——
   * 和以前只算正文（显示 55%、实际 128%）是同一种误导，只是方向反了。
   * 那条数字来自 `turn_start.input`（`assemble.estimates`），不在这里另算。
   */
  const actual = [...thread.messages]
    .reverse()
    .find((message) => message.contextInput)?.contextInput
  const detail = [
    /* ── 真实用量（服务商上报）——放在最前，它才是「花了多少」 ── */
    lastUsage
      ? `最近一次请求（服务商上报）：输入 ${(lastUsage.prompt ?? 0).toLocaleString()} · ` +
        `输出 ${(lastUsage.completion ?? 0).toLocaleString()} token` +
        (lastUsage.cached !== null
          ? `（缓存命中 ${lastUsage.cached.toLocaleString()}，含在输入内）`
          : '')
      : lastMessage && (lastMessage.status === 'streaming' || lastMessage.status === 'sending')
        ? '最近一次请求：统计中（还没拿到服务商的用量）'
        : '最近一次请求：无数据（服务商没返回 usage）',
    knownSum.requests > 0
      ? `本会话累计（已知）：输入 ${knownSum.prompt.toLocaleString()} · 输出 ${knownSum.completion.toLocaleString()} · 合计 ${knownSum.total.toLocaleString()} token，共 ${knownSum.requests} 次请求`
      : '',
    knownSum.unknown > 0
      ? `另有 ${knownSum.unknown} 次请求没有用量上报 —— 那些消耗**未知**，没有算进上面的合计`
      : '',
    /* ── 下面是上下文**估算**：用于裁剪与压缩，不是计费用量 ── */
    `──── 以下是上下文估算（用于裁剪，不是计费）────`,
    `上下文 ${pct}%（估算 ${advice.used.toLocaleString()} / ${advice.limit.toLocaleString()} token）`,
    `口径：按**实际请求体**估（含展开的工具记录与单条 2000 字上限），不是只算正文`,
    window
      ? `分母 = min(模型窗口 ${window.toLocaleString()} × 80%, 你的上限)`
      : '没有这个模型的窗口数据，分母只用你的上限',
    `这条会话存了 ${b.storedMessages.toLocaleString()} 条（估算 ${b.storedTokens.toLocaleString()} token）；` +
      `压缩点之后要带进上下文 ${b.inContextMessages.toLocaleString()} 条，其中工具记录占 ${Math.round(b.toolShare * 100)}%`,
    actual
      ? `上一轮内核**实际**组装：对话层 ${actual.conversationChars.toLocaleString()} / ` +
        `${actual.conversationBudget.toLocaleString()} 字符` +
        `（${Math.round((actual.conversationChars / Math.max(1, actual.conversationBudget)) * 100)}%），` +
        `进上下文 ${actual.selectedMessages.toLocaleString()} 条、裁掉 ${actual.droppedMessages.toLocaleString()} 条`
      : '',
    cached > 0 ? `缓存命中 ${cached.toLocaleString()} token（命中部分便宜很多）` : '',
    advice.auto
      ? '已经超过自动压缩线 —— 下一轮会自动压缩'
      : `距自动压缩线还差约 ${remain.toLocaleString()} token`,
    `百分比是按字符换算的估算，不是 API 计费 token`,
  ]
    .filter(Boolean)
    .join('\n')

  /*
   * 三种状态（方案 A：默认轻量，详情在 tooltip 里）：
   *   · `pending`  —— 正在生成，还没拿到 usage →「统计中」
   *   · `unknown`  —— 结束了但服务商没给 →「无数据」（**不是 0**）
   *   · `known`    —— 有真实数字 →「入 N」
   * 判据只看最近一条回复的状态与它的 usage.known，不猜。
   *
   * ★ 2026-11-09 修：尾部那个 `: 'pending'` 改成 `: 'unknown'`。
   *   以前「一条 assistant 回复都没有」时这里判成「统计中」，而 tooltip
   *   开头那句判成「无数据」—— 同一个渲染里两种状态互相打架（真机逮到：
   *   `data-usage-state="pending"` 旁边写着「最近一次请求：无数据」）。
   *   「没在跑」就不该说统计中。
   */
  const pending = lastMessage?.status === 'streaming' || lastMessage?.status === 'sending'
  const usageState: 'known' | 'pending' | 'unknown' = lastUsage
    ? 'known'
    : pending
      ? 'pending'
      : 'unknown'
  const usageLabel =
    usageState === 'known'
      ? `入 ${(lastUsage?.prompt ?? 0).toLocaleString()}`
      : usageState === 'pending'
        ? '统计中'
        : '无数据'

  return (
    <Tooltip content={detail}>
      <span className="flex shrink-0 items-center gap-1" role="status" aria-label={detail}>
        <svg
          width={RING * 2 + 2}
          height={RING * 2 + 2}
          viewBox={`0 0 ${RING * 2 + 2} ${RING * 2 + 2}`}
        >
          {/* 底环：永远看得见，空的时候也占位（不然数字一变行就跳） */}
          <circle
            cx={RING + 1}
            cy={RING + 1}
            r={RING}
            fill="none"
            stroke={color}
            strokeOpacity={0.25}
            strokeWidth={1.5}
          />
          {/* 用量弧：从 12 点开始顺时针 */}
          <circle
            cx={RING + 1}
            cy={RING + 1}
            r={RING}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - Math.min(1, advice.ratio))}
            transform={`rotate(-90 ${RING + 1} ${RING + 1})`}
          />
        </svg>
        <span className="font-mono">{pct}%</span>
        {/*
         * 最近一次请求的**真实**输入 token（服务商上报）。
         * 三种状态分开：有数 / 统计中 / 无数据 —— 后两种不许显示成 0。
         */}
        <span className="font-mono text-fg-tertiary" data-usage-state={usageState}>
          {usageLabel}
        </span>
      </span>
    </Tooltip>
  )
}

export function ComposerContextRow({
  threadWorkdir,
  status,
  settings,
}: {
  threadWorkdir: string
  status?: string
  settings?: ThreadSettings
}) {
  return (
    <div className="mt-1.5 flex items-center gap-x-3 px-1 text-2xs text-fg-tertiary">
      {/* 工作目录只在这一处显示（右栏和状态栏都不再重复） */}
      <span className="flex min-w-0 flex-1 items-center gap-1" title={`工作目录：${threadWorkdir}`}>
        <span aria-hidden="true" className="shrink-0">
          ⌂
        </span>
        <span className="min-w-0 truncate">{threadWorkdir}</span>
        {status ? <span className="ml-1 shrink-0 text-warning">· {status}</span> : null}
      </span>

      <span className="flex shrink-0 items-center gap-1.5">
        <ContextGauge />
        {settings?.allowNetwork === false ? <span>不联网</span> : null}
        {settings?.allowTools === false ? <span>禁工具</span> : null}
        {settings?.allowWrite === false ? <span>只读</span> : null}
        {settings?.useMemory === false ? <span>无记忆</span> : null}
        <AtSign size={11} />
        提文件
        <Slash size={11} className="ml-1" />
        命令
      </span>
    </div>
  )
}
