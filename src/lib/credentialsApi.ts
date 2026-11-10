import type { WorkbenchBridge } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   凭证库升级（第 17 项）

   从 `safetyApi.ts` 转出来的 —— 那边贴到 300 行红线了（硬约束 2）。
   调用方的 import 路径不用改：`safetyApi.ts` 末尾有 re-export。

   ★ 这是**保数据**的动作：内核先留档、再逐条重加密，留不下档就中止
     （原文件一个字节都不动）。所以失败要原样报出来 —— 用户得知道
     为什么升不了，不能吞成一句「失败了」。
   ══════════════════════════════════════════════════════════════ */

const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

export interface CredentialUpgradeResult {
  ok: boolean
  upgraded?: number
  backend?: string
  reason?: string
  error?: string
}

/** 把明文凭证库**原地升级**成系统加密 */
export async function credentialsUpgrade(): Promise<CredentialUpgradeResult> {
  if (!bridge?.credentialsUpgrade) return { ok: false, error: '浏览器预览没有凭证库' }
  try {
    return await bridge.credentialsUpgrade()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
