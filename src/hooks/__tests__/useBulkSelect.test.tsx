import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { bulkSelectStore, useBulkSelect } from '@/hooks/useBulkSelect'

/* ══════════════════════════════════════════════════════════════
   多选删除：**状态必须是共享的**

   这一组是补漏来的。「多选删除」按钮在 SidebarHeader、列表在 Sidebar，
   而这个 hook 原来内部用 `useState` —— 两个组件各调一次就各拿到一份独立状态。
   点按钮只把 header 那份的 active 置成 true，Sidebar 读到的还是 false，
   结果两种多选（对话文件夹、单独对话）都进不去，而且**不报任何错**：
   tsc、lint、146 项测试全绿。

   所以核心断言是「两处调用看到的是同一份状态」。以前这里是
   `renderToStaticMarkup` —— 那是**服务端渲染**，zustand 在 SSR 下走
   getServerSnapshot，永远返回初始值，测不出状态变化。必须真挂到 DOM 上。
   ══════════════════════════════════════════════════════════════ */

/** 模拟「按钮那一侧」 */
function HeaderProbe(): React.ReactElement {
  const bulk = useBulkSelect()
  return <span data-testid="header">{`${bulk.active}:${bulk.selected.size}`}</span>
}

/** 模拟「列表那一侧」 */
function ListProbe(): React.ReactElement {
  const bulk = useBulkSelect()
  return <span data-testid="list">{`${bulk.active}:${bulk.selected.size}`}</span>
}

let container: HTMLDivElement
let root: Root

/** 读某个探针当前渲染出来的 "active:已选数量" */
function probe(id: string): string {
  return container.querySelector(`[data-testid="${id}"]`)?.textContent ?? ''
}

async function renderBoth(): Promise<void> {
  await act(async () => {
    root.render(
      <>
        <HeaderProbe />
        <ListProbe />
      </>,
    )
  })
}

describe('useBulkSelect', () => {
  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => bulkSelectStore.getState().exit())
    await renderBoth()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('点「多选」后，列表那一侧也能看到 active', async () => {
    expect(probe('header')).toBe('false:0')
    expect(probe('list')).toBe('false:0')

    await act(async () => bulkSelectStore.getState().start())

    /* 关键断言：两处读的是同一份状态（以前 header=true、list=false） */
    expect(probe('header')).toBe('true:0')
    expect(probe('list')).toBe('true:0')
  })

  it('选中项也是共享的', async () => {
    await act(async () => {
      bulkSelectStore.getState().start()
      bulkSelectStore.getState().toggle('t1')
      bulkSelectStore.getState().toggle('t2')
    })
    expect(probe('list')).toBe('true:2')
    expect(probe('header')).toBe('true:2')
  })

  it('再点一次取消选中', async () => {
    await act(async () => {
      bulkSelectStore.getState().start()
      bulkSelectStore.getState().toggle('t1')
      bulkSelectStore.getState().toggle('t1')
    })
    expect(bulkSelectStore.getState().selected.size).toBe(0)
  })

  it('退出会清空选中，两处都回到 false', async () => {
    await act(async () => {
      bulkSelectStore.getState().start()
      bulkSelectStore.getState().toggle('t1')
      bulkSelectStore.getState().exit()
    })
    expect(probe('header')).toBe('false:0')
    expect(probe('list')).toBe('false:0')
  })

  it('重新进入多选时不会带着上次的选中项', async () => {
    await act(async () => {
      bulkSelectStore.getState().start()
      bulkSelectStore.getState().toggle('t1')
      bulkSelectStore.getState().exit()
      bulkSelectStore.getState().start()
    })
    expect(bulkSelectStore.getState().selected.size).toBe(0)
  })
})
