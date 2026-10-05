/* ══════════════════════════════════════════════════════════════
   webview 的「前进 / 后退」—— **每一个调用都必须裹 try/catch**

   ★ 真机踩到的（2026-10-06，加这功能时自己引入的）：
     webview 在「挂上 DOM 且 dom-ready 之前」调任何方法都抛
       The WebView must be attached to the DOM and the dom-ready event
       emitted before this method can be called.
     而这个调用在 React 的 effect 里 → 异常冒出去被错误边界接住 →
     整个浏览器面板变成「这一块出错了」，只能点重试。

   同一个坑 `browseWait.ts` 早就写着注释（"还没挂上，走下面的等待"），
   加新 API 时照它做就行 —— 宁可拿不到状态，也不能把面板炸掉。
   ══════════════════════════════════════════════════════════════ */

type NavCapable = {
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  goBack?: () => void
  goForward?: () => void
}

/** 当前能不能后退/前进。**拿不到状态就都算不能**（按钮灰着，别猜） */
export function navStateOf(view: unknown): { back: boolean; forward: boolean } {
  try {
    const v = view as NavCapable | null
    return { back: v?.canGoBack?.() === true, forward: v?.canGoForward?.() === true }
  } catch {
    return { back: false, forward: false }
  }
}

/** 后退 / 前进。失败就算了 —— 按钮亮着也不代表这一下一定成 */
export function goInView(view: unknown, step: 'back' | 'forward'): void {
  try {
    const v = view as NavCapable | null
    if (step === 'back') v?.goBack?.()
    else v?.goForward?.()
  } catch {
    /* 忽略：没挂上 / 没有历史 */
  }
}
