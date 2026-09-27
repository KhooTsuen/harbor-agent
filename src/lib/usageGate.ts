/* ══════════════════════════════════════════════════════════════
   用量闸：把内核算好的状态翻成一句人话

   **这里不许做判定** —— 只管措辞。判定全在内核 `limits.cjs` 的 `gateState()`
   里（日期口径、0 = 不限、日限优先，都在那边）。这一层再算一遍就会和内核
   悄悄错开，那是这个项目已经踩过一次的坑（闸门永远算成 0）。

   默认状态是**不限**（`enabled: false`，见 config-defaults.cjs）—— 这是个
   保护装置，不该在用户没要求的时候拦住他。所以「没开」要说成中性的一句话，
   不能写成告警：用户看到黄字会以为出了毛病，去查一个本来就没开的开关。
   真正该提醒的是「开关开着、却没填上限」（那种是白设了）。
   ══════════════════════════════════════════════════════════════ */

import type { LimitsGateState } from '@/types/backend'
import { formatCount } from '@/lib/format'
import type { UiStatus } from '@/lib/statusLanguage'

export interface GateLine {
  /**
   * 这一行的状态语义：绿 = 正常、黄 = 需要注意、红 = 已经超了。
   * 颜色由 `STATUS_META` 给（AG-031：语义色只有状态语言表能写），这里不写色值。
   */
  status: UiStatus
  text: string
}

const n = formatCount

/** 「今天已用 X / 上限 Y」这类句子用哪一档语气 */
function ratio(used: number, limit: number): number {
  return limit > 0 ? used / limit : 0
}

/**
 * 把闸门状态翻成 1~3 行话。
 *
 * 返回空数组 = **不说话**：老版本内核不带 `gate` 字段、或浏览器预览里没有配置。
 * 宁可什么都不说，也不要瞎说一句「不限」。
 */
export function gateSummary(gate: LimitsGateState | undefined): GateLine[] {
  if (!gate) return []

  if (!gate.enabled) {
    return [
      {
        status: 'neutral',
        text: '默认不限：不设上限、也不拦请求。想按用量控制，自己打开上面那个开关再填上限。',
      },
    ]
  }

  /* ★ 最容易被误读的状态：开关开着、但上限是空的（0 = 不限） */
  if (gate.idle) {
    return [
      {
        status: 'warning',
        text: '开关开着，但每天 / 每月的上限都是 0 —— 0 表示不限，所以现在等于没设限。要真拦，至少填一个上限。',
      },
      {
        status: 'neutral',
        text: `今天已用 ${n(gate.today)}，本月已用 ${n(gate.month)}（都在记，只是不拦）`,
      },
    ]
  }

  const lines: GateLine[] = []
  const dailyOn = gate.dailyTokens > 0
  const monthlyOn = gate.monthlyTokens > 0

  /* 日限优先说 —— 内核也是先看日限（哪个先超报哪个） */
  if (dailyOn) {
    const left = Math.max(0, gate.dailyTokens - gate.today)
    if (gate.exceeded && gate.level === 'day') {
      lines.push({
        status: 'failed',
        text: `今天已用 ${n(gate.today)} / 上限 ${n(gate.dailyTokens)} —— 已经超了，${gate.onExceed === 'block' ? '下一次调模型会被拦住' : '只会提示，不会拦'}`,
      })
    } else {
      lines.push({
        status: ratio(gate.today, gate.dailyTokens) >= 0.8 ? 'warning' : 'completed',
        text: `今天已用 ${n(gate.today)} / 上限 ${n(gate.dailyTokens)}，还能用 ${n(left)}`,
      })
    }
  }

  if (monthlyOn) {
    const left = Math.max(0, gate.monthlyTokens - gate.month)
    if (gate.exceeded && gate.level === 'month') {
      lines.push({
        status: 'failed',
        text: `本月已用 ${n(gate.month)} / 上限 ${n(gate.monthlyTokens)} —— 已经超了，${gate.onExceed === 'block' ? '下一次调模型会被拦住' : '只会提示，不会拦'}`,
      })
    } else {
      lines.push({
        status: ratio(gate.month, gate.monthlyTokens) >= 0.8 ? 'warning' : 'completed',
        text: `本月已用 ${n(gate.month)} / 上限 ${n(gate.monthlyTokens)}，还能用 ${n(left)}`,
      })
    }
  }

  if (!dailyOn) lines.push({ status: 'completed', text: '每天不限（上限 0）' })
  if (!monthlyOn) lines.push({ status: 'completed', text: '每月不限（上限 0）' })

  lines.push({
    status: 'neutral',
    text: gate.onExceed === 'block' ? '超了之后：直接拦住并报错' : '超了之后：只提示，还会继续跑',
  })
  return lines
}
