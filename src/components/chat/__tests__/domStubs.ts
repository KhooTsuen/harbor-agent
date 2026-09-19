/* ══════════════════════════════════════════════════════════════
   AG-038 基准测试的环境补丁

   jsdom 没有 `ResizeObserver` 和 `matchMedia`，带它们的组件（MessageList、
   AsciiBanner…）在这里根本挂不上 —— 而那些正是要量「卡不卡」的组件。

   注意 ResizeObserver 这个替身**什么都不做**（不触发回调）：基准测的是
   「渲染一次要多久」，回调里的贴底逻辑属于交互，另行验证。
   ══════════════════════════════════════════════════════════════ */

export function installDomStubs(): void {
  const globalAny = globalThis as unknown as Record<string, unknown>

  if (typeof globalAny.ResizeObserver !== 'function') {
    globalAny.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }
}
