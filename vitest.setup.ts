/* React 18 needs this flag for act() to flush updates without warnings. */
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/*
 * jsdom 没有实现 ResizeObserver（它不做真实布局）。
 * 组件里用它监听「内容有没有超出预览高度」，测试环境给一个不回调的空实现即可 ——
 * 测量逻辑本身由 `getBoundingClientRect` 驱动，测试里那是可以 mock 的。
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
