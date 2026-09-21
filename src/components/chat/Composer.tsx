import { useEffect, useState } from 'react'
import { ImageIcon, Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MAX_INPUT_LENGTH } from '@/constants'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { IconButton } from '@/components/ui/IconButton'
import { MenuItem } from '@/components/ui/Popover'
import { Tooltip } from '@/components/ui/Tooltip'
import { ModePicker } from './composer/ModePicker'
import { SendControls } from './composer/SendControls'
import { QueuedMessages } from './composer/QueuedMessages'
import { ModelPicker } from './composer/ModelPicker'
import { MENTIONS, SLASH_COMMANDS } from './composer/completions'
import { SuggestionChips } from './composer/SuggestionChips'
import { NextSteps } from './composer/NextSteps'
import { ComposerContextRow } from './composer/ContextRow'
import { ToolsMenu } from './composer/ToolsMenu'
import { ImageAttachments } from './composer/ImageAttachments'
import { useComposerAttachments } from '@/hooks/useComposerAttachments'
import { fsTree } from '@/lib/fsApi'
import { useAgentActive } from '@/hooks/useAgentActive'
import { PermissionBar } from './PermissionBar'

/* ══════════════════════════════════════════════════════════════ Composer  这是这类工具最有辨识度的组件，结构照它排： ① 输入区 ② 工具行：+ / 模式 / 权限 … 模型 · 推理 · 发送 ③ 上下文行：项目路径 / 提文件 / 命令  发送键是**白色圆形 + 黑色箭头**（实测三张截图一致），不是彩色。 ══════════════════════════════════════════════════════════════ */

export interface ComposerProps {
  onFocusRequest?: () => void
}

/* ── 主组件 ─────────────────────────────────────────────────── */

export function Composer({ onFocusRequest }: ComposerProps) {
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
  const configuredModel = useConfigStore((s) => s.config?.assistant.model)

  const [completionsOpen, setCompletionsOpen] = useState(false)
  const [fileMentions, setFileMentions] = useState<
    Array<{ name: string; path: string; desc: string }>
  >([])

  useEffect(() => {
    let alive = true
    void fsTree().then((tree) => {
      if (!alive || !tree?.ok) return
      const files: Array<{ name: string; path: string; desc: string }> = []
      const walk = (nodes: typeof tree.children) => {
        for (const node of nodes) {
          if (node.type === 'file')
            files.push({ name: node.path, path: node.path, desc: '引用文件' })
          else if (node.children) walk(node.children)
        }
      }
      walk(tree.children)
      setFileMentions(files.slice(0, 500))
    })
    return () => {
      alive = false
    }
  }, [project?.path])

  const { attachImage, pickImage, attachFile, insertImageMessage } = useComposerAttachments()

  /* 当前会话的模式 / 模型 / 推理档位，缺省时回退到全局配置 */
  const mode = thread?.mode ?? 'pair'
  const model = thread?.model || configuredModel || ''
  const reasoning = thread?.reasoning ?? 'high'

  const trimmed = input.trim()
  const tooLong = input.length >= MAX_INPUT_LENGTH
  /* 光贴一张图不写字也该能发 —— 截图提问是很常见的用法 */
  const hasImages = useThreadStore((s) => s.inputImages.length > 0)
  /*
   * 「写了东西」和「能发」是两回事：跑着的时候写了东西也发不出去（下面按钮会变成停止）。
   * 拆开是因为要拿 hasContent 给停止按钮做提示 —— AG-009 留下的「用户以为按钮坏了」。
   */
  const hasContent = trimmed.length > 0 || hasImages
  /* AG-025：sending 时也能发 —— 只是排队（拦不拦由 sendMessage 按 sendingThreads 判断） */
  const canSend = hasContent && !tooLong

  /* 补全菜单：打 / 出命令，打 @ 出文件 */
  const options = (() => {
    const match = /(?:^|\s)([/@])([^\s]*)$/.exec(input)
    if (!match) return []
    if (match[1] === '/') return SLASH_COMMANDS.map((c) => ({ cmd: c.cmd, desc: c.desc }))
    return fileMentions.length > 0
      ? fileMentions
      : MENTIONS.map((m) => ({ name: m.name, desc: m.desc }))
  })()

  function applyCompletion(label: string): void {
    setInput(input.replace(/([/@])[^\s]*$/, `${label} `))
    setCompletionsOpen(false)
  }

  function submit(): void {
    if (!canSend) return
    sendMessage()
  }

  return (
    <div className="px-4 pb-3">
      {/* data-composer-shell：确认面板按它的真实 rect 贴到输入区上方（见 Modal） */}
      <div className="mx-auto w-full max-w-[var(--content-max-width)]" data-composer-shell="">
        <PermissionBar />
        <div
          className={cn(
            'glass-panel relative rounded-md border bg-bg-elevated transition-colors duration-fast',
            'border-line-subtle focus-within:border-line-focus',
            tooLong && 'border-danger',
          )}
        >
          {/* 补全下拉 */}
          {completionsOpen && options.length > 0 ? (
            <div className="glass absolute bottom-full left-0 mb-1.5 max-h-60 w-72 overflow-y-auto rounded-md p-1 shadow-high">
              {options.map((option) => {
                const label = 'cmd' in option ? option.cmd : option.name
                return (
                  <MenuItem key={label} onSelect={() => applyCompletion(label)} hint={option.desc}>
                    <span className="font-mono text-xs">{label}</span>
                  </MenuItem>
                )
              })}
            </div>
          ) : null}

          {/* AG-025：排队中的消息（点 × 删掉一条） */}
          <QueuedMessages
            list={queuedList}
            onRemove={(index) => activeThreadId && removeQueuedMessage(activeThreadId, index)}
          />

          {/* ① 输入区 */}
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setCompletionsOpen(/[/@][^\s]*$/.test(e.target.value))
            }}
            onFocus={onFocusRequest}
            onPaste={(e) => {
              /* 截图直接 Ctrl+V 贴进来 —— 这是最常用的一条路 */
              const files = Array.from(e.clipboardData.files).filter((f) =>
                f.type.startsWith('image/'),
              )
              if (files.length === 0) return
              e.preventDefault()
              for (const file of files) {
                const reader = new FileReader()
                reader.onload = () => {
                  if (typeof reader.result === 'string') attachImage(reader.result)
                }
                reader.readAsDataURL(file)
              }
            }}
            onKeyDown={(e) => {
              if (completionsOpen && (e.key === 'Escape' || e.key === 'Tab')) {
                e.preventDefault()
                setCompletionsOpen(false)
                return
              }
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.altKey &&
                (sendOnEnter || e.ctrlKey || e.metaKey)
              ) {
                e.preventDefault()
                submit()
              }
            }}
            rows={2}
            maxLength={MAX_INPUT_LENGTH + 200}
            placeholder="描述你想让它做什么…"
            aria-label="消息输入框"
            className={cn(
              'block max-h-[200px] min-h-[52px] w-full resize-none rounded-t-md bg-transparent',
              'px-3.5 pb-1 pt-3 text-base leading-relaxed text-fg-primary',
              'placeholder:text-fg-tertiary focus:outline-none',
            )}
          />

          {/* ② 工具行 */}
          <div className="flex items-center gap-1 border-t border-line-subtle px-2 py-1.5">
            <ToolsMenu
              onGenerateImage={insertImageMessage}
              threadSettings={thread?.settings}
              onSettingsChange={(patch) => {
                if (activeThreadId) updateThreadSettings(activeThreadId, patch)
              }}
            />

            <Tooltip content="加一张图片（也可以直接 Ctrl+V 粘贴截图）">
              <IconButton label="添加图片" size={28} onClick={() => void pickImage()}>
                <ImageIcon size={15} />
              </IconButton>
            </Tooltip>

            <Tooltip content="附加一个文本文件">
              <IconButton label="添加附件" size={28} onClick={() => void attachFile()}>
                <Paperclip size={15} />
              </IconButton>
            </Tooltip>

            <ModePicker
              mode={mode}
              onChange={(next) => {
                if (!activeThreadId) return
                setThreadMode(activeThreadId, next)
              }}
            />

            <div className="ml-auto flex items-center gap-1">
              {input.length > MAX_INPUT_LENGTH * 0.8 ? (
                <span
                  className={cn(
                    'mr-1 font-mono text-2xs',
                    tooLong ? 'text-danger' : 'text-fg-tertiary',
                  )}
                  aria-live="polite"
                >
                  {input.length}/{MAX_INPUT_LENGTH}
                </span>
              ) : null}

              <ModelPicker
                model={model}
                reasoning={reasoning}
                onModel={(id) => {
                  if (activeThreadId) setThreadModel(activeThreadId, id)
                }}
                onReasoning={(level) => {
                  if (activeThreadId) setThreadReasoning(activeThreadId, level)
                }}
              />

              <SendControls
                sending={sending}
                hasContent={hasContent}
                canSend={canSend}
                onSend={submit}
                onPause={pauseGeneration}
                onStop={stopGeneration}
              />
            </div>
          </div>
        </div>

        {/* 待发送的图片 */}
        <ImageAttachments />

        {/* 输入框上方只放一样：任务刚跑完 → 下一步（AG-033）；平时 → 建议回复 */}
        <NextSteps />
        {activeThreadId ? (
          <SuggestionChips threadId={activeThreadId} onPick={(text) => setInput(text)} />
        ) : null}

        <ComposerContextRow
          threadWorkdir={contextPath}
          status={thread?.temporary ? '临时对话' : undefined}
          settings={thread?.settings}
        />
      </div>
    </div>
  )
}
