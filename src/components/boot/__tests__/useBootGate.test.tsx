import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useBootGate } from '../useBootGate'

/* ══════════════════════════════════════════════════════════════
   启动门闸（跳过启动动画）

   项目没装 @testing-library/react，所以沿用 useBulkSelect.test.tsx
   那套写法：真挂到 DOM 上，用一个探针组件把状态渲染成 "a:b:c" 再读回来。

   这里最要紧的一条是 **顺序**：点下去之后主界面要**立刻**挂上、启动层
   要**等淡出结束**才结束。反过来（先结束启动层、再挂主界面）中间那一瞬间
   是空白；两个同时结束则淡出动画根本没机会播。所以断言里专门盯着
   「点完 booting 仍然是 true」—— 这条断言就是那个设计的守门员。
   ══════════════════════════════════════════════════════════════ */

const SKIP_FADE_MS = 180

let container: HTMLDivElement
let root: Root
/** 最近一次渲染拿到的 gate 对象，用来调它的方法 */
let gate: ReturnType<typeof useBootGate>

let ready = true
let enabled = true

/** 渲染成 "booting:mainMounted:skipping"，读字符串比逐个对对象属性可靠 */
function Probe(): ReactElement {
  const current = useBootGate(ready, enabled)
  gate = current
  return (
    <span data-testid="gate">{`${current.booting}:${current.mainMounted}:${current.skipping}`}</span>
  )
}

function state(): string {
  return container.querySelector('[data-testid="gate"]')?.textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers()
  ready = true
  enabled = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<Probe />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('useBootGate', () => {
  it('初始：启动层在播、主界面还没挂', () => {
    expect(state()).toBe('true:false:false')
  })

  it('★ 跳过时先挂主界面（立刻），启动层要等淡出结束才结束', () => {
    act(() => gate.skipBoot())
    /* 关键：booting 必须还是 true，否则淡出会一闪而过 */
    expect(state()).toBe('true:true:true')

    act(() => vi.advanceTimersByTime(SKIP_FADE_MS))
    expect(state()).toBe('false:true:true')
  })

  it('★ 连点多次只生效一次（只安排一个定时器）', () => {
    act(() => {
      gate.skipBoot()
      gate.skipBoot()
      gate.skipBoot()
    })
    expect(vi.getTimerCount()).toBe(1)

    act(() => vi.advanceTimersByTime(SKIP_FADE_MS))
    expect(state()).toBe('false:true:true')
  })

  it('数据未就绪时记住跳过请求，加载完成后才进入主界面', () => {
    ready = false
    act(() => root.render(<Probe />))
    act(() => gate.skipBoot())
    expect(state()).toBe('true:false:false')

    ready = true
    act(() => root.render(<Probe />))
    expect(state()).toBe('true:true:true')
    act(() => vi.advanceTimersByTime(SKIP_FADE_MS))
    expect(state()).toBe('false:true:true')
  })

  it('prepareMain 可以重复调，且不会把启动层结束掉', () => {
    act(() => {
      gate.prepareMain()
      gate.prepareMain()
    })
    expect(state()).toBe('true:true:false')

    /* 正常走完（没点跳过）也应该能结束 */
    act(() => gate.finishBoot())
    expect(state()).toBe('false:true:false')
  })

  it('★ 关掉启动动画：主界面直接上，启动层一帧都不渲染', () => {
    enabled = false
    act(() => root.render(<Probe />))
    expect(state()).toBe('false:true:false')
  })

  it('关掉后再点跳过也不受影响（没有残留的启动层、不排定时器）', () => {
    enabled = false
    act(() => root.render(<Probe />))
    act(() => gate.skipBoot())
    expect(state()).toBe('false:true:false')
    expect(vi.getTimerCount()).toBe(0)
  })
})
