/**
 * 类型声明：让 `src/**` 下的 vitest 测试拿到 `browse-settle.cjs` 的类型
 * （内核模块不参与主 tsconfig —— 它只 include `src`）。
 *
 * 实现见 `browse-settle.cjs`。
 */

export const PROBE_SCRIPT: string
export const SETTLE_DEFAULTS: { timeoutMs: number; sampleMs: number; quietSamples: number }

/** 采样状态（`stepQuiet` 进出一趟的东西） */
export interface QuietState {
  sig: string | null
  quiet: number
}

/** 一次探针的结果 */
export interface ProbeResult {
  readyState?: string
  interactions?: number
  mutations?: number
  error?: string
}

export interface SettleResult {
  settled: boolean
  waitedMs: number
  readyState: string
  interactions: number
  samples: number
  failures: number
}

export function stepQuiet(
  state: QuietState | null | undefined,
  probe: ProbeResult | null | undefined,
  quietSamples?: number,
): { sig: string; quiet: number; settled: boolean }

export function settle(
  webContentsId: number,
  options?: {
    timeoutMs?: number
    sampleMs?: number
    quietSamples?: number
    /** 只给测试替换（默认走 CDP）—— 照 browse-read.cjs 的同一套路 */
    evaluate?: (webContentsId: number, script: string) => Promise<unknown>
  },
): Promise<SettleResult>
