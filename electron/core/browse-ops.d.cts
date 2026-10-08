/**
 * 类型声明：让 `src/**` 下的 vitest 测试 + 主进程消费方拿到 `browse-ops.cjs` 的类型
 * （内核模块不参与主 tsconfig —— 它只 include `src`）。
 *
 * 实现见 `browse-ops.cjs`。
 */

export const INTERACTIVE_SEL: string
export const WALK_FN: string
export const CLICK_HELP_FN: string
export const SNAP_KEY: string
export const SNAP_SAVE: string
export const SNAPSHOT_SCRIPT: string

export function snapCheckSnippet(index: number): string
export function clickPointScript(index: number, force?: boolean): string
export function focusScript(index: number, authorized?: boolean): string
export function toIndex(value: unknown): number

/** `runSnapshot` 返回的一个元素 */
export interface SnapItem {
  i: number
  tag: string
  type: string
  role: string
  text: string
  x: number
  y: number
  w: number
  h: number
}

export interface SnapshotResult {
  url?: string
  title?: string
  viewport?: { w: number; h: number }
  items?: SnapItem[]
  total?: number
  error?: string
}

export interface ClickPointResult {
  ok: boolean
  x?: number
  y?: number
  label?: string
  obstructed?: boolean
  error?: string
}

export interface FocusResult {
  ok: boolean
  into?: string
  password?: boolean
  needsConfirm?: boolean
  label?: string
  error?: string
}

export function runSnapshot(webContentsId: number): Promise<SnapshotResult>
export function runClickPoint(
  webContentsId: number,
  index: number,
  force?: boolean,
): Promise<ClickPointResult>
export function runFocus(
  webContentsId: number,
  index: number,
  authorized?: boolean,
): Promise<FocusResult>
