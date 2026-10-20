import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { ToastViewport } from '../Toast'

/* ══════════════════════════════════════════════════════════════
   外观 → 「重要通知记录」开关

   两层判断，**判据必须各自独立**：

     ① 记录处（`useUIStore.showToast`）：关掉后 `toastHistory` 不再增长
     ② 显示处（`ToastViewport`）：关掉后右下角那块整个不渲染

   ★ 为什么要分两个 describe（血泪）：
     第一版把两条判据塞在同一个「总是挂载 ToastViewport」的文件里，
     结果它们**互相兜底**、双双变成永真断言：

       · 去掉「记录处」判断 → 历史真的被写进去了，但显示处的清空 effect
         立刻把它清掉 → 「关掉后不再累积」照样通过；
       · 去掉「显示处」判断 → 按钮本该出现，但记录处已经把历史拦成空的
         → 「关掉后按钮不渲染」照样通过。

     反向验证（临时把判断改坏）两次都是「6 项全绿」才暴露出这一点。
     修法就是让每条判据**只依赖被它钉的那一处**：
       · 记录处的判据**不挂载界面**（没有清空 effect 来兜底）；
       · 显示处的判据**硬塞历史**（不经过 showToast，绕过记录处的拦截）。
     ══════════════════════════════════════════════════════════════ */

/** 设开关（走真实 store，不 mock —— 要钉的就是它接没接上） */
function setNoticeHistory(value: boolean): void {
  act(() => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, noticeHistory: value } }))
  })
}

let mounted: { host: HTMLDivElement; root: Root } | null = null

function mount(): HTMLDivElement {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<ToastViewport />))
  mounted = { host, root }
  return host
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  useUIStore.setState({ toasts: [], toastHistory: [] })
  setNoticeHistory(true)
})

afterEach(() => {
  if (mounted) {
    act(() => mounted?.root.unmount())
    mounted.host.remove()
    mounted = null
  }
  vi.useRealTimers()
  setNoticeHistory(true)
  useUIStore.setState({ toasts: [], toastHistory: [] })
})

/* ── ① 记录处：**不挂载界面** ── */
describe('记录处 · showToast 是否累积历史', () => {
  it('默认开：错误会进记录', () => {
    act(() => {
      useUIStore.getState().showToast('error', '模型连接失败', '请检查连接')
    })
    expect(useUIStore.getState().toastHistory).toHaveLength(1)
  })

  it('★ 关掉后不再累积记录（不是只藏按钮）', () => {
    setNoticeHistory(false)
    act(() => {
      useUIStore.getState().showToast('error', '模型连接失败', '请检查连接')
      useUIStore.getState().showToast('warning', '预算快用完了')
    })
    expect(useUIStore.getState().toastHistory).toHaveLength(0)
  })

  it('★ 关掉不等于静音：错误提示本身照旧弹出来', () => {
    setNoticeHistory(false)
    act(() => {
      useUIStore.getState().showToast('error', '模型连接失败', '请检查连接')
    })
    /* 正在弹的那条还在（这是「即时提示」），只是没进历史 */
    expect(useUIStore.getState().toasts).toHaveLength(1)
  })

  it('★ 恢复默认（字段缺失）按开处理 —— 老配置读进来行为不变', () => {
    /*
     * 走**真实的归一化函数**（`normalize` 是模块内的，但 DEFAULT_SETTINGS 与
     * 归一化表达式是同源的两条），这里钉的是「口径」而不是某个调用点：
     * 缺字段必须是「开」，否则老用户的界面会突然少一块。
     */
    expect(DEFAULT_SETTINGS.noticeHistory).toBe(true)
    const src = readFileSync(join(process.cwd(), 'src/stores/useSettingsStore.ts'), 'utf8')
    /* 归一化口径：只有显式 false 才关（与 bootAnimation / animations 同一写法） */
    expect(src).toContain('noticeHistory: s.noticeHistory !== false')
  })
})

/* ── ② 显示处：**硬塞历史**，绕过记录处 ── */
describe('显示处 · 右下角那块渲不渲染', () => {
  /** 直接写进 store（不走 showToast）—— 这样就不受记录处的开关判断影响 */
  function seedHistory(): void {
    act(() => {
      useUIStore.setState({
        toastHistory: [{ id: 't1', kind: 'error', title: '先来一条' }],
      })
    })
  }

  it('开着 + 有历史 → 按钮出现', () => {
    seedHistory()
    const host = mount()
    expect(host.textContent).toContain('重要通知记录')
  })

  it('★ 关掉后按钮整块不渲染（历史仍然存在也不渲染）', () => {
    seedHistory()
    setNoticeHistory(false)
    /* 开关在**挂载前**就是关的：清空逻辑只在「开→关那一刻」触发，
       所以这里不会替显示处兜底 —— 这条判据单独依赖显示处自己的判断。 */
    const host = mount()
    expect(host.textContent).not.toContain('重要通知记录')
    /* 历史确实还在（证明不是「因为被清空了才不显示」） */
    expect(useUIStore.getState().toastHistory.length).toBeGreaterThan(0)
  })

  it('★ 运行中把开关关掉 → 旧记录被清掉（重开从零开始）', () => {
    seedHistory()
    const host = mount()
    expect(useUIStore.getState().toastHistory).toHaveLength(1)

    setNoticeHistory(false)
    expect(useUIStore.getState().toastHistory).toHaveLength(0)

    /* 再打开：从零开始，不会冒出关之前的旧通知 */
    setNoticeHistory(true)
    expect(useUIStore.getState().toastHistory).toHaveLength(0)
    expect(host.textContent).not.toContain('重要通知记录')
  })
})
