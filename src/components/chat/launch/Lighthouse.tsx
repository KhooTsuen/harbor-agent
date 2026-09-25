import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   开屏灯塔（设计文档 §11 / §13.1）

   「灯塔本身既是状态组件也是轻量彩蛋」：
     · 光来自**真实应用状态** —— 不是循环假演的"正在处理"；
     · 空闲的光非常慢（≥8s 周期）、低对比，不抢注意力；
     · 等确认/等恢复时是琥珀色小脉冲；离线时灯灭、只留轮廓；
     · sweepSeq 变化 = 完整扫一次（夜航解锁 / 测试全绿），只播一次。

   动态的停止条件都写在这：
     · 窗口失焦/最小化 → .harbor-paused（animation-play-state: paused）
     · data-animations='off' 或系统减少动态 → CSS 里直接关掉（见 index.css）
   ══════════════════════════════════════════════════════════════ */

export type LighthouseState = 'idle' | 'scanning' | 'running' | 'awaiting' | 'offline' | 'error'

/*
 * 灯塔光的颜色：
 *   · 蓝光束 = --accent-blue（强调色，豁免名单里的「选中/链接同款」）；
 *   · 等确认 / 离线 / 错误各自走 statusLanguage 表（不再自己写语义色）。
 */
const BEAM_COLOR: Record<LighthouseState, string> = {
  idle: 'var(--accent-blue)',
  scanning: 'var(--accent-blue)',
  running: 'var(--accent-blue)',
  awaiting: colorOf('waiting'),
  offline: colorOf('neutral'),
  error: colorOf('failed'),
}

/** 灯灭的只有离线；错误是短促一瞥后回到静态（由调用方控制停留时间） */
function beamOpacity(state: LighthouseState): number {
  if (state === 'offline') return 0.08
  if (state === 'awaiting') return 0.4
  return 0.32
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const onChange = (): void => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return hidden
}

export function Lighthouse({ state, sweepSeq }: { state: LighthouseState; sweepSeq: number }) {
  const hidden = useDocumentHidden()
  const [sweeping, setSweeping] = useState(false)

  /* sweepSeq=0 是初始值（不播）；每次 +1 播一次 1.6 秒 */
  useEffect(() => {
    if (sweepSeq === 0) return
    setSweeping(true)
    const timer = setTimeout(() => setSweeping(false), 1700)
    return () => clearTimeout(timer)
  }, [sweepSeq])

  const color = BEAM_COLOR[state]
  const fast = state === 'running' || state === 'scanning'
  const pulse = state === 'awaiting'

  return (
    <svg
      viewBox="0 0 360 200"
      className={cn('harbor-lighthouse pointer-events-none select-none', hidden && 'harbor-paused')}
      aria-hidden="true"
    >
      {/* 光束：左右各一，透明度随状态走动画（离线不参与动画，只留暗轮廓） */}
      <g>
        <path
          className={cn(
            state !== 'offline' && 'harbor-beam',
            fast && 'harbor-beam-fast',
            pulse && 'harbor-beam-alert',
          )}
          d="M180 46 L36 18 L36 74 Z"
          fill={color}
          opacity={beamOpacity(state)}
        />
        <path
          className={cn(
            state !== 'offline' && 'harbor-beam',
            fast && 'harbor-beam-fast',
            pulse && 'harbor-beam-alert',
          )}
          d="M180 46 L324 18 L324 74 Z"
          fill={color}
          opacity={beamOpacity(state)}
        />
      </g>

      {/* 完整扫一次（夜航解锁 / 测试全绿）—— 一条横光带 */}
      {sweeping ? (
        <g className="harbor-sweep">
          <rect x="0" y="30" width="360" height="28" fill={color} opacity="0.22" rx="14" />
        </g>
      ) : null}

      {/* 塔身（低对比；离线时整体更暗） */}
      <g stroke="var(--border-strong)" strokeWidth="1.2">
        <path
          d="M170 60 L190 60 L196 138 L164 138 Z"
          fill="var(--bg-active)"
          opacity={state === 'offline' ? 0.5 : 0.9}
        />
        <rect x="164" y="52" width="32" height="8" rx="2" fill="var(--bg-raised)" />
        {/* 灯室：状态色的小圆 */}
        <circle
          className={cn(pulse && 'harbor-lamp-pulse')}
          cx="180"
          cy="45"
          r="6"
          fill={color}
          opacity={state === 'offline' ? 0.25 : 0.9}
        />
      </g>

      {/* 岸线：一条安静的地平线 */}
      <path
        d="M20 160 Q120 150 180 158 T340 160"
        stroke="var(--border-hairline)"
        strokeWidth="1"
        fill="none"
      />
      <path
        d="M96 156 Q180 170 264 156"
        stroke="var(--border-hairline)"
        strokeWidth="1"
        fill="none"
        opacity="0.6"
      />
    </svg>
  )
}
