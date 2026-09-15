import type { WorkbenchBridge } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   诊断包

   出问题时一键导出「版本 / 配置 / 日志 / 会话结构」，用户直接粘给开发者。
   API Key 在主进程侧就打码了，可以安全外发。

   从 backend.ts 拆出来的 —— 那边又顶到 300 行了。
   ══════════════════════════════════════════════════════════════ */

const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

export async function copyDiagnostics(): Promise<{
  ok: boolean
  chars?: number
  errorCount?: number
  logLines?: number
  error?: string
}> {
  if (!bridge) return { ok: false, error: '浏览器预览没有真实后端' }
  try {
    return await bridge.diagnosticsCopy()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function saveDiagnostics(): Promise<{
  ok: boolean
  canceled?: boolean
  path?: string
  error?: string
}> {
  if (!bridge) return { ok: false, error: '浏览器预览没有真实后端' }
  try {
    return await bridge.diagnosticsSave()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
