import { bridge } from './bridge'

/**
 * 压缩点的**写盘结果**（P0-2，2026-10-23）
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────
 *
 * `backend.ts` 贴着 300 行红线；而这件事只有一条规矩，值得单独说清楚。
 *
 * ── 修的是什么 ───────────────────────────────────────────────
 *
 * 真机复现的「假压缩成功」：界面弹「已压缩 30 条 → 一段摘要」、消息流里也插了
 * 压缩点，但磁盘上**没有**那条 `compact` 记录 —— 重启后一切照旧，模型照样收到
 * 压缩前的全量历史。原因有两层：
 *
 *   ① `backend.ts` 的 `appendCompact` 把 `await bridge.appendCompact(...)` 包在
 *      一个空 catch 里（注释写的是「落盘失败不影响当前对话」），返回 `void`。
 *      桥抛错（主进程写不进、会话文件被删…）时，调用方看到的是「成功」。
 *   ② 内核 `session-write.appendCompact` 写失败时自己抛，而 IPC 把异常变成
 *      reject —— 一旦渲染层吞掉，就没人在意了。
 *
 * 现在两头都如实：内核返回 `{ ok: false, error }`，这里把它**原样**交回调用方，
 * 由 `runCompact` 决定要不要改界面（只有 `ok === true` 才插压缩点、才提示成功）。
 *
 * ★ 这条函数**不再吞任何错误**：桥抛异常也翻成 `{ ok: false, error }`，
 *   因为「写没写进去」比「有没有抛」对调用方更有用。
 * ★ 浏览器预览（没有桥）返回失败而不是静默成功 —— 「假装压缩了」正是要修的病。
 */
export async function appendCompact(
  id: string,
  summary: string,
  upTo: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持写压缩点，请使用桌面版' }
  try {
    const result = await bridge.appendCompact(id, summary, upTo)
    if (result?.ok === true) return { ok: true }
    return { ok: false, error: result?.error ?? '压缩点没有写进会话文件（主进程未确认）' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
