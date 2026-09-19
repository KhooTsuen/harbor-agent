import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   轻量操作反馈（AG-032）

   文档的例子：已复制 / 已保存 / 已暂停 / 已加入队列 / 已取消 / 已创建分支。
   要求「短暂 Toast / Inline Feedback，**不阻塞用户**」。

   这一组把「静默的动作」逐个钉住 —— 之前这些动作做完界面上什么都不说，
   用户只能靠猜：停止有没有生效、归档去哪了、分支是不是切错地方了。

   为什么测 store 而不是组件：反馈写在动作里（一处改，所有入口都受益），
   直接调动作就能断言，不用挂 React。
   ══════════════════════════════════════════════════════════════ */

const toasts = () => useUIStore.getState().toasts
const last = () => toasts().at(-1)

beforeEach(() => {
  useAppStore.getState().resetAll()
  useThreadStore.setState({ queuedMessages: {}, sendingThreads: [] })
  useUIStore.setState({ toasts: [] })
})

describe('AG-032 / 文档点名的六种反馈', () => {
  it('已暂停（AG-011 就有的那条，别弄丢）', () => {
    useThreadStore.getState().pauseGeneration()
    expect(last()?.title).toBe('正在暂停')
  })

  it('★ 已停止', () => {
    useThreadStore.getState().stopGeneration()
    expect(last()?.title).toBe('已停止')
    expect(last()?.kind).toBe('info')
  })

  it('★ 已加入队列（措辞与文档对齐）', () => {
    const id = useAppStore.getState().activeThreadId
    useThreadStore.setState({ sendingThreads: [id] })
    useThreadStore.setState({ input: '排队这句' })
    useThreadStore.getState().sendMessage()
    expect(last()?.title).toBe('已加入队列')
    expect(useThreadStore.getState().queuedMessages[id]).toEqual(['排队这句'])
  })

  it('★ 已移出队列', () => {
    const id = useAppStore.getState().activeThreadId
    useThreadStore.getState().enqueueMessage(id, '一句话')
    useUIStore.setState({ toasts: [] })
    useThreadStore.getState().removeQueuedMessage(id, 0)
    expect(last()?.title).toBe('已移出队列')
    expect(useThreadStore.getState().queuedMessages[id]).toBeUndefined()
  })

  it('★ 已创建分支（会切到新对话，不说一句像切错了）', () => {
    const source = useAppStore.getState().threads[0]
    const before = useAppStore.getState().activeThreadId
    const branchId = useAppStore.getState().branchThread(source.id, source.messages[0]?.id ?? '')
    expect(branchId).toBeTruthy()
    expect(last()?.title).toBe('已创建分支')
    /* 确实切过去了，反馈里带上新名字 */
    expect(useAppStore.getState().activeThreadId).toBe(branchId)
    expect(last()?.description).toContain('分支')
    expect(useAppStore.getState().activeThreadId).not.toBe(before)
  })

  it('★ 已复制是就地反馈（不是 toast）—— 代码块那颗勾', () => {
    /* 「已复制」用行内 ✓ 表示：比弹一条 toast 更轻，也不打断阅读 */
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'components/chat/codeblock/Header.tsx'),
      'utf8',
    )
    expect(src).toContain('copied ?')
  })
})

describe('AG-032 / 其余静默动作', () => {
  it('★ 置顶 / 取消置顶', () => {
    /* 种子数据里本来就有一条置顶的 —— 挑一条**未置顶**的，断言才不依赖种子 */
    const target = useAppStore.getState().threads.find((t) => !t.pinned)
    if (!target) throw new Error('没有未置顶的对话')
    useAppStore.getState().togglePinThread(target.id)
    expect(last()?.title).toBe('已置顶')
    useAppStore.getState().togglePinThread(target.id)
    expect(last()?.title).toBe('已取消置顶')
  })

  it('★ 归档 / 取消归档（那行会从列表消失，得说清去哪了）', () => {
    const target = useAppStore.getState().threads.find((t) => !t.archived)
    if (!target) throw new Error('没有未归档的对话')
    useAppStore.getState().toggleArchiveThread(target.id)
    expect(last()?.title).toBe('已归档')
    useAppStore.getState().toggleArchiveThread(target.id)
    expect(last()?.title).toBe('已取消归档')
  })

  it('反馈都是「轻量」的：走 toast 通道，不弹模态', () => {
    useThreadStore.getState().stopGeneration()
    const toast = last()
    expect(toast).toBeTruthy()
    /* 没有动作按钮 = 不需要用户回应，看一眼就过去 */
    expect(toast?.action).toBeUndefined()
    /* 模态框没被打开 */
    expect(useUIStore.getState().permission).toBeNull()
  })
})
