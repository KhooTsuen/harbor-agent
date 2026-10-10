import { useEffect } from 'react'
import { subscribeDownloadsEvent } from '@/lib/subscriptions'
import { useDownloadsStore } from '@/stores/useDownloadsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useRealBackend } from '@/lib/backend'

/* ══════════════════════════════════════════════════════════════
   下载的即时提示（渲染层，全局一份）

   病根（2026-10-11 真机）：下载事件的订阅原来长在 `DownloadsPanel` 里，
   而面板是**按标签条件渲染**的（`RightPanel.tsx`：`activeRightTab === 'downloads'`）。
   于是用户在内置**浏览器**里点一个下载链接时，右栏多半没停在「下载」标签
   → 事件推到渲染层没人接 → 「点了下载什么反应都没有」，失败了也不知道。

   所以把订阅搬到**常驻**的地方（`useBackendSubscriptions` 里挂一次），
   面板只管渲染。这一处同时负责两件事：

     · 把事件喂给 `useDownloadsStore` —— 面板没开时数据也保持最新
       （用户切过去就是最新的，不用等它重新拉）；
     · 对「开始 / 完成 / 失败」三种跃迁弹一条提示。

   为什么只弹这三种：`progress` 每 200ms 一条，弹它等于刷屏；
   `paused` / `queued` / `removed` / `cleared` 多是**用户自己点的**，他知道。
   ══════════════════════════════════════════════════════════════ */

/** 点提示上的「查看」→ 右栏落到「下载」标签 */
function openDownloads(): void {
  useUIStore.getState().setActiveRightTab('downloads')
}

export function useDownloadNotifications(): void {
  useEffect(() => {
    if (!useRealBackend) return
    return subscribeDownloadsEvent((event) => {
      /* 唯一的订阅点：先喂 store（面板没开也要保持最新），再决定弹不弹 */
      useDownloadsStore.getState().applyEvent(event)

      const showToast = useUIStore.getState().showToast
      const name = String(event.name ?? '').trim()
      const view = { label: '查看', onClick: openDownloads }

      if (event.type === 'started') {
        showToast('info', '开始下载', name || '已加入队列', view)
      } else if (event.type === 'done') {
        showToast('success', '下载完成', name, view)
      } else if (event.type === 'failed') {
        showToast('error', '下载失败', String(event.error ?? '').trim() || name, view)
      }
    })
  }, [])
}
