import { useState } from 'react'
import { MAX_INPUT_LENGTH } from '@/constants'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useCompletions } from './useCompletions'
import { useComposerAttachments } from '@/hooks/useComposerAttachments'
import { useAgentActive } from '@/hooks/useAgentActive'

/* ══════════════════════════════════════════════════════════════
   Composer 的状态与逻辑（从 Composer.tsx 拆出来的）

   原来这一大段和 JSX 挤在同一个组件里，文件贴到 300 行红线。
   抽成 hook 的**理由**：这一段的产物是「一堆值和几个动作」，
   和它画成什么样没关系 —— 放在一起时，改一处 UI 要在一堆订阅里翻找。
   JSX 那边只做一次 useComposerState() 解构。
   ══════════════════════════════════════════════════════════════ */

export function useComposerState() {
  const input = useThreadStore((s) => s.input)
  const setInput = useThreadStore((s) => s.setInput)
  const sendMessage = useThreadStore((s) => s.sendMessage)
  const stopGeneration = useThreadStore((s) => s.stopGeneration)
  const pauseGeneration = useThreadStore((s) => s.pauseGeneration)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  /* AG-025：当前对话排队的消息（跑着时用户又发的）。必须在 activeThreadId 之后声明 */
  const queuedList = useThreadStore((s) =>
    activeThreadId ? s.queuedMessages[activeThreadId] : undefined,
  )
  const removeQueuedMessage = useThreadStore((s) => s.removeQueuedMessage)
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))

  const sending = useAgentActive(thread?.id)
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId))
  /* 这条对话所属的文件夹（不是「当前选中的」—— 那是两回事） */
  const threadFolder = useAppStore((s) => s.projects.find((p) => p.id === thread?.projectId))
  /* 全局默认工作目录：这条对话没挂文件夹时用它 */
  const configWorkdir = useAppStore((s) => s.workdir)
  /* 底部那行显示什么目录：自己的 → 所属文件夹的 → 默认的 */
  const contextPath =
    thread?.workdir ||
    threadFolder?.path ||
    `${configWorkdir || project?.path || '默认工作目录'}（默认）`
  const setThreadMode = useAppStore((s) => s.setThreadMode)
  const setThreadModel = useAppStore((s) => s.setThreadModel)
  const setThreadReasoning = useAppStore((s) => s.setThreadReasoning)
  const updateThreadSettings = useAppStore((s) => s.updateThreadSettings)

  const sendOnEnter = useSettingsStore((s) => s.settings.sendOnEnter)
  /*
   * 输入框高度：拖动期间只走**本地** state —— 每动一像素就写全局设置的话，
   * 所有订阅 settings 的组件（含消息列表）都得跟着重渲。松手才落设置。
   */
  const savedComposerHeight = useSettingsStore((s) => s.settings.composerHeight)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [draggingHeight, setDraggingHeight] = useState<number | null>(null)
  const composerHeight = draggingHeight ?? savedComposerHeight
  const configuredModel = useConfigStore((s) => s.config?.assistant.model)

  /* 补全（打 / 出命令、打 @ 出文件）—— 逻辑在 composer/useCompletions.ts */
  const completions = useCompletions(input, setInput, project?.path)

  const { attachFromClipboard, pickImage, attachFile, insertImageMessage } =
    useComposerAttachments()

  /* 当前会话的模式 / 模型 / 推理档位，缺省时回退到全局配置 */
  const mode = thread?.mode ?? 'pair'
  const model = thread?.model || configuredModel || ''
  const reasoning = thread?.reasoning ?? 'high'

  const trimmed = input.trim()
  const atLimit = input.length >= MAX_INPUT_LENGTH /* 只作提示，不拦发送：见 constants */
  /* 光贴一张图不写字也该能发 —— 截图提问是很常见的用法 */
  const hasImages = useThreadStore((s) => s.inputImages.length > 0)
  /*
   * 「写了东西」和「能发」是两回事：跑着的时候写了东西也发不出去（下面按钮会变成停止）。
   * 拆开是因为要拿 hasContent 给停止按钮做提示 —— AG-009 留下的「用户以为按钮坏了」。
   */
  const hasContent = trimmed.length > 0 || hasImages
  /* AG-025：sending 时也能发 —— 只是排队（拦不拦由 sendMessage 按 sendingThreads 判断） */
  const canSend = hasContent /* 长度不参与：能写出来就能发（上限由输入框与 store 卡住） */

  /* 补全菜单开不开 / 有哪些候选项，都由 useCompletions 管 */

  function submit(): void {
    if (!canSend) return
    sendMessage()
  }

  return {
    input,
    setInput,
    stopGeneration,
    pauseGeneration,
    activeThreadId,
    queuedList,
    removeQueuedMessage,
    thread,
    sending,
    contextPath,
    sendOnEnter,
    composerHeight,
    setDraggingHeight,
    updateSettings,
    completions,
    attachFromClipboard,
    pickImage,
    attachFile,
    insertImageMessage,
    mode,
    setThreadMode,
    model,
    setThreadModel,
    reasoning,
    setThreadReasoning,
    atLimit,
    hasContent,
    canSend,
    submit,
    updateThreadSettings,
  }
}
