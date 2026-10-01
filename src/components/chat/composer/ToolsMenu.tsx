import { useState } from 'react'
import { FileImage, ImagePlus, Sparkles, Wand2 } from 'lucide-react'
import type { ThreadSettings } from '@/types'
import { sceneImage, sceneOcr, sceneOptimize } from '@/lib/sceneApi'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { IconButton } from '@/components/ui/IconButton'
import { MenuItem, MenuLabel, Popover } from '@/components/ui/Popover'
import { Tooltip } from '@/components/ui/Tooltip'

/* ══════════════════════════════════════════════════════════════
   Composer 的工具菜单

   三个「辅助动作」，都不改对话流，只是帮你把输入弄好或者产出一张图：
     · 优化提示词 —— 把随口一句话改写成清晰指令，替换输入框
     · 图片转文字 —— 选张截图，把文字抠出来填进输入框
     · 生成图片   —— 按描述画一张，作为消息插进对话

   单独一个文件是因为 Composer 本体已经接近 300 行。
   ══════════════════════════════════════════════════════════════ */

/**
 * 「先问我想清楚」那句请求（AG-053 批④）。
 *
 * ⚠️ 这句话和内核**认的是同一句** —— `core/clarify-session.cjs` 的 `looksLikeAskMe`
 *   就是照着它写的。改这里必须同步那边（自检 **103 组**直接从这里读那句字面量，
 *   再拿去问内核认不认 —— 两边对不上就红）。
 */
const ASK_ME_PHRASE = '先问我几个问题再动手，我要自己拿主意。'

export function ToolsMenu({
  onGenerateImage,
  threadSettings,
  onSettingsChange,
}: {
  onGenerateImage: (prompt: string, image: string) => void
  threadSettings?: ThreadSettings
  onSettingsChange: (patch: Partial<ThreadSettings>) => void
}) {
  const input = useThreadStore((s) => s.input)
  const setInput = useThreadStore((s) => s.setInput)
  const showToast = useUIStore((s) => s.showToast)

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')

  /** 把一句话改写成清晰指令，直接替换输入框 */
  async function optimize(): Promise<void> {
    setOpen(false)
    const text = input.trim()
    if (!text) {
      showToast('info', '先写点什么', '优化是把你的话改写得更清楚')
      return
    }

    setBusy('optimize')
    const result = await sceneOptimize(text)
    setBusy('')

    if (result.ok && result.text) {
      setInput(result.text)
      showToast('success', '已优化', '不满意可以撤销（Ctrl+Z）')
    } else {
      showToast('error', '优化失败', result.error)
    }
  }

  /** 选一张图，把文字抠出来填进输入框 */
  async function ocr(): Promise<void> {
    setOpen(false)
    setBusy('ocr')

    /* 要 base64 data URL，普通文本读法不够用，所以单独走一个 IPC */
    const picked = await window.workbench?.pickImageAsDataUrl()
    if (!picked || picked.canceled) {
      setBusy('')
      return
    }
    if (!picked.ok || !picked.dataUrl) {
      setBusy('')
      showToast('error', '读图失败', picked.error)
      return
    }

    const result = await sceneOcr(picked.dataUrl)
    setBusy('')

    if (result.ok && result.text) {
      setInput(input ? `${input}\n\n${result.text}` : result.text)
      showToast('success', '识别完成', `${result.text.length} 个字`)
    } else {
      showToast('error', '识别失败', result.error)
    }
  }

  /**
   * AG-053 批④：把「先问我」那句请求填进输入框。
   *
   * 为什么是填字而不是直接发：他往往还要补一句背景（「顺便说明为什么选它」），
   * 而且直接替他发一条消息太「自作主张」—— 这个项目里那是红线。
   */
  function askMeFirst(): void {
    setOpen(false)
    const phrase = ASK_ME_PHRASE
    setInput(input.trim() ? `${phrase}\n${input}` : phrase)
    showToast('info', '下次开工前会先问你', '可以直接发出去（想补背景就接着写）')
  }

  /** 按当前输入框里的描述画一张图 */
  async function generate(): Promise<void> {
    setOpen(false)
    const prompt = input.trim()
    if (!prompt) {
      showToast('info', '先写描述', '比如：一只猫坐在窗台上，水彩风格')
      return
    }

    setBusy('image')
    const result = await sceneImage(prompt)
    setBusy('')

    if (result.ok && result.image) {
      onGenerateImage(prompt, result.image)
      /* 图片已经交给上层插进对话了，输入框清掉免得误发 */
      setInput('')
      showToast('success', '画好了', result.model ?? '')
    } else {
      showToast('error', '生成失败', result.error)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      trigger={({ toggle }) => (
        <Tooltip content="辅助工具">
          <IconButton label="辅助工具" size={28} onClick={toggle} disabled={busy !== ''}>
            <Wand2 size={15} className={busy ? 'animate-pulse' : undefined} />
          </IconButton>
        </Tooltip>
      )}
    >
      <MenuLabel>本次对话</MenuLabel>
      <MenuItem
        onSelect={() => onSettingsChange({ allowNetwork: threadSettings?.allowNetwork === false })}
      >
        {threadSettings?.allowNetwork === false ? '联网：关闭' : '联网：开启'}
      </MenuItem>
      <MenuItem
        onSelect={() => onSettingsChange({ allowTools: threadSettings?.allowTools === false })}
      >
        {threadSettings?.allowTools === false ? '工具：关闭' : '工具：开启'}
      </MenuItem>
      <MenuItem
        onSelect={() => onSettingsChange({ allowWrite: threadSettings?.allowWrite === false })}
      >
        {threadSettings?.allowWrite === false ? '写入：禁止' : '写入：允许'}
      </MenuItem>
      <MenuItem
        onSelect={() => onSettingsChange({ useMemory: threadSettings?.useMemory === false })}
      >
        {threadSettings?.useMemory === false ? '记忆：关闭' : '记忆：开启'}
      </MenuItem>
      {/*
        AG-053 批④：「手动唤醒」。连跳两次之后澄清会被静音 —— 那是「别老问了」，
        不是「永远别问」。这个按钮把**那句请求**填进输入框（他还能接着补两句），
        发出去之后内核认出来就当场解除静音（core/clarify-session.cjs 的 looksLikeAskMe）。
      */}
      <MenuItem onSelect={() => askMeFirst()} hint="静音之后想被问时点它">
        先问我想清楚
      </MenuItem>
      <div className="my-1 h-px bg-line-subtle" role="separator" />
      <MenuLabel>辅助工具</MenuLabel>

      <MenuItem
        onSelect={() => void optimize()}
        icon={<Sparkles size={13} />}
        hint={busy === 'optimize' ? '处理中…' : undefined}
      >
        优化提示词
      </MenuItem>

      <MenuItem
        onSelect={() => void ocr()}
        icon={<FileImage size={13} />}
        hint={busy === 'ocr' ? '识别中…' : undefined}
      >
        图片转文字
      </MenuItem>

      <MenuItem
        onSelect={() => void generate()}
        icon={<ImagePlus size={13} />}
        hint={busy === 'image' ? '生成中…' : undefined}
      >
        生成图片
      </MenuItem>
    </Popover>
  )
}
