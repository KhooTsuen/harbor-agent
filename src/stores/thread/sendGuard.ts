import { withSendableImages } from '@/lib/imageSend'

/* ══════════════════════════════════════════════════════════════
   发送前的图片闸门

   从 `turns.ts` 抽出来的两个原因：
     · 那边贴着 300 行红线（这段一塞就破）；
     · 「发不出去就别装成发出去了」是一个**能单独说清**的规则，值得有名字。

   行为（用户 2026-09-28 真机 400）：历史里的旧巨图要先洗掉；洗不动的
   （TIFF / HEIC）**不静默丢图**，而是把原因交回调用点去提示用户并中止。
   ══════════════════════════════════════════════════════════════ */

export type SendableHistory<T> = { ok: true; history: T[] } | { ok: false; error: string }

export async function guardSendableImages<T extends { content: unknown }>(
  history: T[],
): Promise<SendableHistory<T>> {
  try {
    return { ok: true, history: await withSendableImages(history) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
