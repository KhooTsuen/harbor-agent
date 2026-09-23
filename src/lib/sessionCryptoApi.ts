import type { SessionCryptoBridgeState, SessionCryptoMigrateResult } from '@/types/session-crypto'

/* ══════════════════════════════════════════════════════════════
   会话内容加密的桥包装

   `src/types/backend.ts` 已经正好 300 行，**不许再加**，所以桥方法在这里
   就地声明（和 `artifactApi.ts` 同一个办法），并做**能力探测**：
   桥没接上时面板显示一句人话并降级，不崩、不白屏。
   ══════════════════════════════════════════════════════════════ */

type SessionCryptoBridge = {
  sessionCrypto?: () => Promise<SessionCryptoBridgeState>
  setSessionCrypto?: (enable: boolean) => Promise<SessionCryptoMigrateResult>
}

const bridge =
  typeof window !== 'undefined'
    ? (window.workbench as unknown as SessionCryptoBridge | undefined)
    : undefined

export type SessionCryptoState = SessionCryptoBridgeState
export type SessionCryptoResult = SessionCryptoMigrateResult

export function sessionCryptoBridgeReady(): boolean {
  return typeof bridge?.sessionCrypto === 'function'
}

/** 查状态；拿不到（没桥 / 主进程报错）返回 null，调用方降级 */
export async function fetchSessionCrypto(): Promise<SessionCryptoState | null> {
  try {
    return (await bridge?.sessionCrypto?.()) ?? null
  } catch {
    return null
  }
}

/**
 * 开 / 关。
 *
 * ⚠️ 这个调用**会重写盘上的全部会话文件**（内核那边先备份），所以拿不到结果时
 * 一律按失败处理并把话说清楚 —— 不能因为「没拿到返回值」就当成功了。
 */
export async function setSessionCrypto(enable: boolean): Promise<SessionCryptoResult> {
  try {
    const result = await bridge?.setSessionCrypto?.(enable)
    if (!result) return { ok: false, error: '当前版本没接上这个桥，没有改动任何文件' }
    return result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
