import { useEffect, useRef } from 'react'
import { useBrowserStore } from '@/stores/useBrowserStore'
import { sameUrl } from '@/lib/url'
import {
  BROWSE_BUDGET_MS,
  Budget,
  waitForDomReady,
  waitForElement,
  waitForLoad,
  type WebviewElement,
} from './browseWait'

/* ══════════════════════════════════════════════════════════════
   执行 Agent 的浏览请求（真正操作 webview 的那一半）

   `useBrowseBridge`（挂在 RightPanel）负责接请求、开标签，
   这里负责等 webview 挂上 → 导航 → 报就绪（读正文 / 读元素 / 点 / 打字 / 换历史
   全交**主进程**经 CDP 做，见 `electron/core/browse-*.cjs`）。

   ★ B5（2026-10-09）：这里现在**只处理 `navigate`**（开 / 复用标签）——
     那是唯一必须由渲染层做的事（`<webview>` 是它的 DOM 元素）。其余动作主进程
     手里有 webContentsId 就直连了，不再往这儿派。就绪时把 wcid 推给主进程
     （`browserActive`），主进程据此读正文 / 缓存下来直连。

   ★ 全部等待共享一条总预算（见 `browseWait.ts`）：主进程等 45 秒，
     这条预算是 30 秒 —— 渲染层**必须**先回话。真机踩过：三段等待各管各的，
     相加 48 秒 > 45 秒，于是慢页面一律被判成「界面没有在 45 秒内回应」，
     而那句话是错的（界面在干活，只是还没读完）。
   ══════════════════════════════════════════════════════════════ */

/**
 * 消费 store 里的 pending 请求（B5 后只会是 navigate），并**把当前标签的 wcid 推给主进程**。
 *
 * @param webviewRef 指向 BrowserTab 里那个 webview 元素
 * @param sessionId  当前会话号（推 wcid 时带上，主进程按会话缓存）
 * @param activeId   当前**显示**的标签 id（换标签要重新推 —— 驱动的是另一个 webview）
 */
export function useBrowseDriver(
  webviewRef: React.RefObject<WebviewElement | null>,
  sessionId: string,
  activeId: string,
): void {
  const pending = useBrowserStore((s) => s.pending)
  const clearPending = useBrowserStore((s) => s.clearPending)
  /* 正在处理的那一个，避免重复执行 */
  const busyRef = useRef<string | null>(null)
  /* 上一次 effect 还活着吗 —— 见下面那道闸的注释 */
  const liveRef = useRef(false)

  /*
   * ★ B5（2026-10-09）：把**当前**标签的 webContentsId 推给主进程。
   *
   * 主进程靠它经 CDP 直连这个 webview（读正文 / 读元素 / 点 / 打字 / 换历史），
   * 不必每次动作都往返渲染层。三种时机都要推：切换标签（驱动的是另一个 webview）、
   * `dom-ready`（页面就绪，wcid 才可用）、页内导航后（同上）。
   *
   * ⚠️ 只能推**当前那个**：webviewRef 的回调只把 active 的那个赋进来（见 BrowserTab 的 ref），
   * 所以这里拿到的就是「正在被 Agent 驱动」的那个，不会推错成别的标签。
   */
  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    const push = (): void => {
      /*
       * ⚠️ 必须裹 try/catch：webview 刚挂进 DOM、还没发 `dom-ready` 时，
       * 调任何方法都抛「must be attached to the DOM and the dom-ready event
       * emitted」。而这个 push 在 effect 里会**立即**跑一次（下一行），
       * 异常从 effect 冒出去就被错误边界接住 → 整个浏览器面板「这一块出错了」
       * （2026-10-09 真机，B5 引入）。拿不到先不推，`dom-ready` 响了会再推。
       * 与 `webviewNav.ts` 的规矩一致：宁可拿不到状态，也不能把面板炸掉。
       */
      try {
        const wcId = view.getWebContentsId?.()
        if (typeof wcId !== 'number') return
        void window.workbench?.browserActive?.({ sessionId, webContentsId: wcId })
      } catch {
        /* 还没 dom-ready —— 等事件，这次不推 */
      }
    }
    push()
    const names = ['dom-ready', 'did-navigate', 'did-navigate-in-page', 'did-finish-load']
    for (const name of names) view.addEventListener(name, push)
    return () => {
      for (const name of names) view.removeEventListener(name, push)
    }
  }, [webviewRef, sessionId, activeId])

  useEffect(() => {
    if (!pending) return
    /*
     * 同一条请求已在处理 → 不重复执行。
     * 但**只挡还活着的那一次**：React 18 StrictMode 会「挂载→立刻卸载→再挂载」，
     * 死掉的那次会一直占着 busyRef，于是唯一活着的那次被挡掉 —— 开发模式下
     * 每次浏览都静默失败（主进程一直等到 45 秒超时）。真机复现过。
     */
    if (busyRef.current === pending.id && liveRef.current) return
    busyRef.current = pending.id
    liveRef.current = true

    let alive = true
    /*
     * 这一条请求回过话没有。
     * 卸载/换请求时要靠它判断「该不该补一条失败回话」—— 见下面 cleanup 里的注释。
     */
    let replied = false

    const push = (result: { ok: boolean; webContentsId?: number; error?: string }): void => {
      replied = true
      /* 拿 id 的这一刻就记牢：cleanup 里再读 pending 可能已经是下一条了 */
      void window.workbench?.browserActive?.({
        requestId: pending!.id,
        sessionId: pending!.sessionId ?? '',
        ...result,
      })
    }

    async function run(): Promise<void> {
      /* 等 webview 挂上（切到浏览器标签后才会有）—— 跟后面几步共用同一条预算 */
      const budget = new Budget()
      const view = await waitForElement(() => webviewRef.current, budget)
      if (!alive) return
      if (!view) {
        push({
          ok: false,
          error: `等浏览器标签出来超时（已等 ${Math.round(BROWSE_BUDGET_MS / 1000)} 秒）。右侧那个「浏览器」标签手动点开一下，再让我读。`,
        })
        clearPending()
        return
      }

      try {
        /* ① 先等它可用 —— 不等的话调任何方法都会报「must be attached to the DOM」 */
        await waitForDomReady(view, budget)
        if (!alive) return

        /*
         * 导航：新标签的 `src` 已经是目标地址了，webview 自己会去 —— 这种情况不用再
         * loadURL（多调一次会白闪一下）。只有复用旧标签、地址不一致时才手动导。
         * 比地址用 sameUrl：`example.com` 和 `example.com/` 是同一个页面，严格比较
         * 会判定成不一致 → 白 loadURL 一次 → 页面重新加载（表单就没了）。
         */
        const current = view.getURL?.() ?? ''
        if (current && !sameUrl(current, pending!.url)) {
          const loading = view.loadURL?.(pending!.url)
          if (loading && typeof loading.then === 'function') await loading.catch(() => undefined)
          await waitForLoad(view, budget)
        }

        /*
         * 走到这儿 = **页面就绪**。读正文 / 读元素 / 点 / 打字 / 换历史全交
         * **主进程**经 CDP 做（见 `electron/core/browse-*.cjs`）——
         * 渲染层只负责「开标签 + 导航 + 等就绪 + 报 webContentsId」。
         *
         * 但超时仍要**渲染层自己说**：不让主进程用「界面没有在 45 秒内回应」这种
         * 猜出来的原因替它发言（真机上就是这么误导的：界面其实在干活）。
         */
        if (budget.expired) {
          push({
            ok: false,
            error: `等页面就绪超时（已等 ${Math.round(BROWSE_BUDGET_MS / 1000)} 秒，这个站点可能太慢或一直加载中）`,
          })
          return
        }
        push({ ok: true, webContentsId: view.getWebContentsId?.() ?? 0 })
      } catch (error) {
        if (!alive) return
        push({ ok: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        clearPending()
      }
    }

    void run()

    return () => {
      alive = false
      liveRef.current = false
      /*
       * ★ 没回过话就当场回一条（2026-10-05 真机反馈 1c）。
       *
       * 以前这里只是 `alive = false` —— 请求就这么**被丢掉**了：主进程那头
       * 一直等到 45 秒超时才回话，用户看到的是「界面没有在 45 秒内回应」，
       * 而界面早就知道这条请求做不完了。凡是界面已经知道结果的情况，
       * 就该马上说清楚，别让主进程去猜。
       *
       * 判断「是不是真被丢掉了」看 store 里当前那条请求：
       *   · cleanup 先于新 effect 跑 —— 「被新请求顶掉」时 store 里已经是新的 id → 回话 ✓
       *   · 被 closeAll 清掉 / 换成 null → 也回话 ✓
       *   · StrictMode 复挂、或单纯重渲染（还是同一条）→ **不回话**，
       *     因为马上就会有另一次执行接着把它做完
       */
      const current = useBrowserStore.getState().pending
      if (!replied && current?.id !== pending!.id) {
        push({
          ok: false,
          error:
            '页面已切换：这条浏览请求在执行途中被打断了（浏览器标签换了、被关了，或者面板被切走）。重新发起一次，或先手动点开右侧「浏览器」再试。',
        })
      }
    }
  }, [pending, webviewRef, clearPending])
}
