import type { Message, Thread } from '@/types'
import { useRealBackend } from '@/lib/backend'
import { fetchMessagesFromDisk, fetchWorkspaceFromDisk } from './disk'
import type { AppState } from './types'

/* ══════════════════════════════════════════════════════════════
   磁盘读写动作（loadFromDisk / openFromDisk）

   从 useAppStore.ts 拆出来的 —— 那边贴 300 行了。
   这两个动作是一对，而且**互相影响**（刷新工作区会不会清掉已读的消息），
   放一起才看得出来，所以没有各拆各的。

   ── 为什么要有 loadingThreadId ──────────────────────────────
   openFromDisk 是「先切选中、再去读消息」，读要几十到几百毫秒
   （千条会话真机 ~700ms）。这段窗口里 `thread.messages` 是**空数组**，
   界面分不清它是「刚建的空对话」还是「正在读」—— 以前一律渲染开屏
   （launch/LaunchScreen.tsx），而开屏一挂上就跑工作区扫描 / 未完成任务 /
   凭据检查一串 IPC 还要画灯塔，然后消息到了整个丢掉。

   真机量过：切千条会话那次 **65–76ms 长任务**就在这一刻（CPU Profile 里
   是 `fillText` / `fillRect` 一片 canvas 绘制 + 一堆原生 deserialize）。
   所以读的时候挂个 id 出来，界面改画骨架。
   ══════════════════════════════════════════════════════════════ */

type Setter = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
type Getter = () => AppState

type DiskActions = Pick<AppState, 'loadFromDisk' | 'openFromDisk' | 'hydrateThread'>

/**
 * 元数据刷新时**留住内存里已有的消息**。
 *
 * 会话列表是从磁盘元数据重建的（只有条数/标题/时间，没有消息），直接换上去
 * 会把打开着的会话清成空数组 —— 于是界面闪一下开屏，而 `openFromDisk` 那条
 * 「读盘期间没人动过消息才允许覆盖」的守卫也会因为引用变了而**把读回来的消息丢掉**
 * （症状：点了会话，侧栏高亮切过去了，消息区一直还是上一个会话）。
 */
export function mergeThreads(current: readonly Thread[], fresh: readonly Thread[]): Thread[] {
  return fresh.map((thread) => {
    const old = current.find((t) => t.id === thread.id)
    return old && old.messages.length > 0 ? { ...thread, messages: old.messages } : thread
  })
}

/**
 * 重读盘回来时：**保住内存里正在跑的那一轮**，其余听磁盘的。
 *
 * ★ 为什么必须有（2026-11-04 真机，用户报「注入时流式对话断了、但后台还在跑」）：
 *
 *   浏览器扩展送进来的内容由**主进程直接写会话文件**，写完推 `ext:page`，渲染层
 *   收到就重读盘（见 `hooks/useExtBridge.ts`）。而磁盘上**没有**正在流式的那一条
 *   （它只在分段快照里，是几秒前的一份），所以整份覆盖之后占位消息就没了 ——
 *   之后每个分片调的 `updateMessage(placeholder.id)` 全都找不到目标：界面停在
 *   那一刻看着像「被打断」，而主进程那一轮根本没被取消，照旧跑到底。
 *   更糟的一半：收尾落盘按 id 找那条消息（见 `replyPersistence.persistReply`），
 *   找不到就整轮不写 —— 磁盘上只剩几秒前那份快照，重开显示「这条回复没写完」。
 *
 * 判据只有一条 `status === 'streaming'`：**没有正在跑的一轮时原样返回磁盘那份**，
 * 老行为零变化（引用守卫仍由调用方管）。
 */
export function mergeLiveMessages(fromDisk: Message[], current: readonly Message[]): Message[] {
  const live = current.filter((m) => m.status === 'streaming')
  if (live.length === 0) return fromDisk

  /*
   * 磁盘上属于这些在跑回复的分段快照要丢掉：快照用占位消息的 id 当 key
   * （`persistMessage(threadId, { key: messageId, … })`），读回时落在 `diskKey`
   * —— 内存里那份一定比它新，留着就是同一轮出现两条、一条还是半截。
   */
  const liveKeys = new Set(live.map((m) => m.id))
  const disk = fromDisk.filter((m) => !liveKeys.has(m.id) && !liveKeys.has(m.diskKey ?? ''))

  /*
   * 内存里**磁盘上还没有**的消息也要接上（刚发的提问、排队那条）：
   * 判据用时间 —— 只取晚于磁盘最新一条的那些，老会话不会被误留（它们的 ts 都更早）。
   */
  const lastDiskTs = fromDisk.reduce((max, m) => (m.timestamp > max ? m.timestamp : max), 0)
  const pending = current.filter((m) => m.status !== 'streaming' && (m.timestamp ?? 0) > lastDiskTs)

  return [...disk, ...pending, ...live]
}

export function makeDiskActions(set: Setter, get: Getter): DiskActions {
  return {
    loadFromDisk: async () => {
      if (!useRealBackend) return
      const result = await fetchWorkspaceFromDisk()
      set((state) => ({
        /* 每个项目 = 侧栏一个文件夹；内核记着上次选中的是哪个（已失效则回退第一个） */
        projects: result.folders.map((f) => f.project),
        threads: mergeThreads(state.threads, result.threads),
        activeProjectId: result.activeId || (result.folders[0]?.project.id ?? ''),
        activeThreadId: result.threads.some((t) => t.id === state.activeThreadId)
          ? state.activeThreadId
          : (result.threads[0]?.id ?? ''),
      }))
    },

    openFromDisk: async (id) => {
      if (!useRealBackend) return
      set({ activeThreadId: id })
      const before = get().threads.find((t) => t.id === id)
      /* 内存里没有它的消息 = 这次真要去读：挂上 loading，界面别把空数组当空对话 */
      const mustRead = (before?.messages.length ?? 0) === 0
      if (mustRead) set({ loadingThreadId: id })
      /*
       * 卡住「读回来的时候把刚加的消息盖掉」这个真 bug：
       *
       * 这条 `await` 期间用户完全可能已经发消息了 —— `resumeTask`（点「继续」）
       * 就是 setActiveThread 紧接着 sendMessage，中间没有等待。
       * 读回来直接 set 就会把刚插进去的用户消息 + 流式占位一起抹掉，
       * 界面上就是「点继续以后对话一片空白，但 Agent 其实在跑」。
       *
       * 判据：内存里还是**调用前那个数组**（没人动过）才允许覆盖。
       * 注意不能用「长度是不是 0」—— 并发删消息也照样能把数组改成别的。
       */
      try {
        const messages = await fetchMessagesFromDisk(id)
        if (!messages) return
        const current = get().threads.find((t) => t.id === id)
        if (!current) return
        /*
         * 卡住「读回来的时候把刚加的消息盖掉」这个真 bug：
         *
         * 这条 `await` 期间用户完全可能已经发消息了 —— `resumeTask`（点「继续」）
         * 就是 setActiveThread 紧接着 sendMessage，中间没有等待。
         * 读回来直接 set 就会把刚插进去的用户消息 + 流式占位一起抹掉，
         * 界面上就是「点继续以后对话一片空白，但 Agent 其实在跑」。
         *
         * ★ 2026-11-04 补一层：**有正在跑的一轮时不能整份放弃**（原来这里直接 return）。
         *   扩展注入恰好发生在流式中（见 mergeLiveMessages 的文件头），整份放弃的结果是
         *   注入的内容一直不显示；而等到某个空档又一次性覆盖，把流式那条顶掉。
         *   现在改成「合并」：磁盘那份 + 内存里正在跑的那条（及其之后）。
         */
        const touched = current.messages !== before?.messages
        const running = current.messages.some((m) => m.status === 'streaming')
        if (touched && !running) return
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === id ? { ...t, messages: mergeLiveMessages(messages, current.messages) } : t,
          ),
        }))
      } finally {
        if (mustRead)
          set((state) => (state.loadingThreadId === id ? { loadingThreadId: null } : {}))
      }
    },

    hydrateThread: async (id) => {
      if (!useRealBackend) return
      const before = get().threads.find((t) => t.id === id)
      /* 不在列表里 = 调用方得先 loadFromDisk 让它出现 */
      if (!before) return
      /*
       * ★ 2026-10-21 修「点两次才能传进 Harbor」：这里以前是
       *   `if (!before || before.messages.length > 0) return` —— **已经有消息就什么都不做**。
       *   而扩展读到的内容由主进程直接写盘（渲染层不知情），那条会话本来就有消息，
       *   于是第一次的刷新被这句吞掉，用户以为没成功、再点一次才看见
       *   （实测会话文件里成对写入、间隔 1–3 秒，共 30 条）。
       *   现在照常重读；只在**确实没有被改过**时才覆盖（与 openFromDisk 同一个守卫）。
       *
       * ★ 2026-11-04：与 openFromDisk 同一处放宽 —— 有正在跑的一轮时改走合并，
       *   否则流式那条会被顶掉（见 mergeLiveMessages）。
       */
      try {
        const messages = await fetchMessagesFromDisk(id)
        if (!messages) return
        const current = get().threads.find((t) => t.id === id)
        if (!current) return
        const touched = current.messages !== before.messages
        const running = current.messages.some((m) => m.status === 'streaming')
        if (touched && !running) return
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === id ? { ...t, messages: mergeLiveMessages(messages, current.messages) } : t,
          ),
        }))
      } catch {
        /* 读失败就让它空着：这一轮上下文会缺这段，但不该因此崩掉整条发送 */
      }
    },
  }
}
