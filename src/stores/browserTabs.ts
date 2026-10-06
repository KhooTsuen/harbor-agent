/* ══════════════════════════════════════════════════════════════
   浏览器标签：归属 + 「选谁」

   从 useBrowserStore.ts 拆出来的（那边加完「Agent 自己决定开不开新标签」之后
   过了 300 行 —— 硬约束 #2）。这里全是**纯函数**：给一组标签，回答
   「本会话有哪些 / 现在该显示谁 / Agent 该驱动谁」。状态本身还在 store 里。

   ⚠️ 这几个口径是**唯一真相源**：BrowserTab（显示）、useBrowseBridge（判断有没有页面）、
   useBrowseDriver（驱动哪个元素）都从这里取，别各写一遍。
   ══════════════════════════════════════════════════════════════ */

export interface BrowserTabItem {
  id: string
  url: string
  /**
   * 这个标签属于**哪个会话**（标签栏按会话隔离，真机反馈 6）。
   * 会话号就是 `Thread.id`；`''` = 还不知道属于谁（只会在测试里出现）。
   */
  sessionId: string
  /**
   * 谁开的这个标签。
   * `user`  = 在地址栏里自己开的：Agent 不许把它当成"自己那一个"拿去改地址；
   * `agent` = Agent 导航开出来的：Agent 的点击 / 输入 / 后退只落在这种标签上。
   */
  owner: 'user' | 'agent'
  /**
   * 这个标签的 webview 重建计数（手动「重新加载」用）。
   * 放在**每个标签**上，不是全局一个 —— 以前全局一个，一重载就把当前 webview 换了；
   * 而标签常驻之后，全局值还会让切标签也跟着重建（见 BrowserTab 的注释）。
   */
  reloadKey: number
}

/**
 * 本会话的标签（真机反馈 6：标签栏按会话隔离）。
 *
 * 口径：`sessionId` 等于本会话，或者「还没认领归属的用户标签」——
 * 后者是兜底（地址栏建标签时还没来得及盖章），**别的会话的标签永远不会混进来**。
 * `visibleTabOf` 与 BrowserTab 的标签栏都调它，别各写一遍。
 */
export function tabsOfSession(
  tabs: readonly BrowserTabItem[],
  sessionId: string,
): BrowserTabItem[] {
  return tabs.filter((t) => t.sessionId === sessionId || (t.sessionId === '' && t.owner === 'user'))
}

/**
 * 当前该**显示**、也该被 Agent 驱动的那一个标签。
 *
 * 只看本会话的标签 —— 别的会话的标签留在 DOM 里继续活着，但不显示、也不被驱动。
 */
export function visibleTabOf(
  tabs: readonly BrowserTabItem[],
  sessionId: string,
  activeId: string,
): BrowserTabItem | undefined {
  const mine = tabsOfSession(tabs, sessionId)
  return mine.find((t) => t.id === activeId) ?? mine[mine.length - 1]
}

/**
 * 本会话里**属于 Agent 自己**的那个标签（没有就 undefined）。
 *
 * 为什么要它（2026-10-07 真机反馈）：`owner` 以前是个**死字段** —— 注释写着
 * 「Agent 不许把用户自己开的标签当成自己那一个」，但全仓搜下来没有任何地方读它。
 * 结果是用户点回自己开的标签看时，Agent 的点击 / 输入 / 后退会作用在他正看的
 * 那一页上，把人家的页面点走。
 *
 * 与 `visibleTabOf` 分工：那个管**显示谁**（跟随用户点的标签），这个只管
 * **Agent 该驱动谁**（只认自己开的）。`activeId` 指着其中一个就用它，否则用最后一个。
 */
export function agentTabOf(
  tabs: readonly BrowserTabItem[],
  sessionId: string,
  activeId: string,
): BrowserTabItem | undefined {
  const mine = tabs.filter((t) => t.owner === 'agent' && t.sessionId === sessionId)
  return mine.find((t) => t.id === activeId) ?? mine[mine.length - 1]
}
