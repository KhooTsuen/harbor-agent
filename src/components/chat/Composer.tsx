import { ImageIcon, Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LAYOUT, MAX_INPUT_LENGTH } from '@/constants'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
import { IconButton } from '@/components/ui/IconButton'
import { MenuItem } from '@/components/ui/Popover'
import { Tooltip } from '@/components/ui/Tooltip'
import { ModePicker } from './composer/ModePicker'
import { SendControls } from './composer/SendControls'
import { QueuedMessages } from './composer/QueuedMessages'
import { ModelPicker } from './composer/ModelPicker'
import { SuggestionChips } from './composer/SuggestionChips'
import { NextSteps } from './composer/NextSteps'
import { ComposerContextRow } from './composer/ContextRow'
import { ToolsMenu } from './composer/ToolsMenu'
import { ImageAttachments } from './composer/ImageAttachments'
import { FileAttachments } from './composer/FileAttachments'
import { CapabilityWarning } from './composer/CapabilityWarning'
import { PlanBar } from './composer/PlanBar'
import { useComposerState } from './composer/useComposerState'
import { AboveInputCards } from './AboveInputCards'

/* ══════════════════════════════════════════════════════════════ Composer  这是这类工具最有辨识度的组件，结构照它排： ① 输入区 ② 工具行：+ / 模式 / 权限 … 模型 · 推理 · 发送 ③ 上下文行：项目路径 / 提文件 / 命令  发送键是**白色圆形 + 黑色箭头**（实测三张截图一致），不是彩色。 ══════════════════════════════════════════════════════════════ */

export interface ComposerProps {
  onFocusRequest?: () => void
}

/* ── 主组件 ─────────────────────────────────────────────────── */

export function Composer({ onFocusRequest }: ComposerProps) {
  const {
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
    attachFiles,
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
  } = useComposerState()

  return (
    <div className="px-4 pb-3">
      {/* data-composer-shell：确认面板按它的真实 rect 贴到输入区上方（见 Modal） */}
      {/*
        注（2026-10-04）：「框变高时整块上浮、底栏跟着一起移」试过，但那条与
        「手柄贴住指针」在算术上互斥 —— 手柄位置 = 下沿 − 高度，下沿再上浮一次，
        手柄会以鼠标两倍速度跑（量到：拖 60px、手柄跑 76px），所以保持「上沿跟着指针、下沿钉住」。
      */}
      <div className="mx-auto w-full max-w-[var(--content-max-width)]" data-composer-shell="">
        {/* AG-053：权限条与澄清卡在这里，由 AboveInputCards 仲裁只显示一张 */}
        <AboveInputCards />
        {/*
          输入框高度可拖：这条线压在面板上沿，往上拖变高、往下拖变矮，
          松手就固定在拖到的位置（写进设置，重启还在）。范围见 LAYOUT.composer。
        */}
        <ResizeHandle
          orientation="vertical"
          side="top"
          label="调整输入框高度"
          value={composerHeight}
          min={LAYOUT.composer.min}
          max={LAYOUT.composer.max}
          hitBottom={4}
          onChange={setDraggingHeight}
          onCommit={(next) => {
            setDraggingHeight(null)
            updateSettings({ composerHeight: next })
          }}
        />
        <div
          className={cn(
            'glass-panel relative rounded-md border bg-bg-input transition-colors duration-fast',
            'border-line-subtle focus-within:border-line-focus',
            atLimit && 'border-danger',
          )}
        >
          {/* 补全下拉 */}
          {completions.open && completions.options.length > 0 ? (
            <div className="glass absolute bottom-full left-0 mb-1.5 max-h-60 w-72 overflow-y-auto rounded-md p-1 shadow-high">
              {completions.options.map((option) => {
                const label = 'cmd' in option ? option.cmd : option.name
                return (
                  <MenuItem
                    key={label}
                    onSelect={() => completions.apply(label)}
                    hint={option.desc}
                  >
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

          {/*
            计划栏在**输入框上方**：放下方会把输入框往上顶（整块贴底，下方一变高
            输入框就跟着动）—— 位置变来变去很烦。上方则输入框离视口的距离不变。
          */}
          {activeThreadId ? <PlanBar threadId={activeThreadId} /> : null}

          {/* ① 输入区。高度由上面那条拖拽线决定，不再是写死的 max-h/min-h */}
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              completions.syncFromText(e.target.value)
            }}
            onFocus={onFocusRequest}
            onPaste={(e) => {
              /* 截图直接 Ctrl+V 贴进来 —— 这是最常用的一条路。
                 格式/尺寸归整在 hook 里（剪贴板经常给 BMP，上游只收 4 种格式） */
              if (attachFromClipboard(e)) e.preventDefault()
            }}
            onKeyDown={(e) => {
              if (completions.open && (e.key === 'Escape' || e.key === 'Tab')) {
                e.preventDefault()
                completions.close()
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
            maxLength={MAX_INPUT_LENGTH + 200}
            placeholder="描述你想让它做什么…"
            aria-label="消息输入框"
            /* 高度是唯一权威：不写 rows（写了也只会误导，CSS height 本来就盖过它） */
            style={{ height: composerHeight }}
            className={cn(
              'block w-full resize-none overflow-y-auto rounded-t-md bg-transparent',
              'px-3.5 pb-1 pt-3 text-base leading-relaxed text-fg-primary',
              'placeholder:text-fg-tertiary focus:outline-none',
            )}
          />

          {/* ② 工具行。whitespace-nowrap：窄窗口下「标准」「deepseek-chat」会被折成两行（真机截到过） */}
          <div className="flex items-center gap-1 whitespace-nowrap border-t border-line-subtle px-2 py-1.5">
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
              <IconButton label="添加附件" size={28} onClick={() => void attachFiles()}>
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
                    atLimit ? 'text-danger' : 'text-fg-tertiary',
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
        {/* 待发送的文件（任何格式） */}
        <FileAttachments />
        {/* 这活当前模型干得了吗（据声明，不是实测） */}
        <CapabilityWarning />

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
