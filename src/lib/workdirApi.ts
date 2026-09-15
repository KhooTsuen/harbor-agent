import type { WorkbenchBridge } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   工作目录相关的桥包装

   两个容易混的操作，差别只在一句话上：
     pickWorkdir()   —— 「我以后默认用哪个目录」（会改全局设置）
     chooseFolder()  —— 「这条对话挂在哪个目录」（不动全局设置）

   从 backend.ts 拆出来的（那边过 300 行了）。
   ══════════════════════════════════════════════════════════════ */

const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

/** 当前生效的工作目录 */
export async function getWorkdir(): Promise<string | null> {
  if (!bridge) return null
  try {
    return await bridge.getWorkdir()
  } catch {
    return null
  }
}

/**
 * 只挑一个目录并返回，**不改全局工作目录**。
 * 用于「把这条对话挂到某个目录」——那不该顺手改掉全局默认。
 */
export async function chooseFolder(): Promise<{ ok: boolean; dir?: string }> {
  if (!bridge) return { ok: false }
  try {
    const result = await bridge.chooseFolder()
    return result.ok && result.dir ? { ok: true, dir: result.dir } : { ok: false }
  } catch {
    return { ok: false }
  }
}

export async function pickWorkdir(): Promise<{ ok: boolean; workdir?: string }> {
  if (!bridge) return { ok: false }
  try {
    return await bridge.pickWorkdir()
  } catch {
    return { ok: false }
  }
}

/* ── 供应商 ───────────────────────────────────────────────── */
/* 实现在 providerApi.ts，这里转发出去，外部 import 路径不用改 */
