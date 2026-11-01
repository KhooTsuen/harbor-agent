/**
 * 上下文开关的**唯一判定处**（扩展侧）
 *
 * ── 它是什么 ───────────────────────────────────────────────────
 *
 * 侧边栏「当前网页卡」右上角那个 checkbox（`PageCard.tsx`）。用户关掉它 = 
 * **不想让这个页面进对话**。所以「读当前页」「观察页面」这两条会往会话里
 * 写内容的路径，都要先问它一句。
 *
 * ── 为什么必须有这个文件（而不是在按钮里判断）───────────────
 *
 * 判据要落在**真正发请求的那一层**（`service-worker.js` 的 `readActivePage`
 * 与 `lib/observe-run.js` 的 `observeSessionPage`），否则：
 *   · 按钮上判断 → 别处调同一个能力（比如未来某个自动流程）就绕过去了；
 *   · 两处各写一遍 → 必然漂（一条链路认开关、另一条不认，用户看到的是「有时管用」）。
 * 所以判定只此一处，两条链路都调它。
 *
 * ── 默认值 ─────────────────────────────────────────────────────
 *
 * **没存过 = 开**（与 `page-info.ts` 的 `ctxEnabledFrom` 同一口径）。
 * 装好就能用；关掉是用户主动动作。读不出来（storage 坏了）也按开 ——
 * 那是「没配置」不是「用户关了」，不能因此把功能锁死；真读不到页面时
 * 后面那一步会自己报人话。
 */

/* global chrome */

/** 存储键 —— 必须与 `src/sidepanel/page-info.ts` 的 `CTX_KEY` 一致（自检钉着） */
export const CTX_KEY = 'harborContextEnabled'

/**
 * 现在允许把页面内容带进对话吗？
 *
 * @returns {Promise<{ allowed: boolean, error: string }>} 不允许时 `error` 是**人话**
 */
export async function contextAllowed() {
  let stored
  try {
    stored = await chrome.storage.local.get(CTX_KEY)
  } catch {
    return { allowed: false, error: '无法读取网页上下文设置；为避免误传页面内容，已暂停读取。请重试或检查扩展存储。' }
  }
  if (stored && stored[CTX_KEY] === false) {
    return {
      allowed: false,
      error: '上下文已关闭（当前网页卡右上角的「带上」没勾）—— 想看这个页面就先把它勾上',
    }
  }
  return { allowed: true, error: '' }
}
