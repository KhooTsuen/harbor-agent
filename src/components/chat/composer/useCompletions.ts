import { useEffect, useState } from 'react'
import { fsTree } from '@/lib/fsApi'
import { MENTIONS, SLASH_COMMANDS } from './completions'

/* ══════════════════════════════════════════════════════════════
   输入框的补全（从 `Composer.tsx` 抽出来的，2026-10-04 小尾巴 #2）

   那个文件只剩 5 行余量，而这一块**自成一体**：打 `/` 出命令、打 `@` 出文件，
   外加「文件清单从哪来」。抽出来之后 Composer 只管画。

   两条容易踩的规则：
     · 触发条件是**行尾**的 `/xxx` 或 `@xxx`（`/([/@])[^\s]*$/`）——
       正文中间出现的 `@` 不该弹菜单；
     · 文件清单只在挂载/换目录时读一次（`fsTree` 是 IPC，每敲一个字读一次会很吵）。
   ══════════════════════════════════════════════════════════════ */

/** 补全项：命令只有 cmd/desc，文件有 name/path/desc（备选清单只有 name/desc） */
export type CompletionOption =
  { cmd: string; desc: string } | { name: string; path?: string; desc: string }

export interface Completions {
  /** 菜单开着没有（由输入内容推导） */
  open: boolean
  options: CompletionOption[]
  /** 输入变了之后调：按新文本判断菜单该不该开 */
  syncFromText: (text: string) => void
  /** 关掉菜单（Esc / Tab） */
  close: () => void
  /** 选中一项：把 `[/@]xxx` 换成它并留一个空格 */
  apply: (label: string) => void
}

const TRIGGER = /(?:^|\s)([/@])([^\s]*)$/

export function useCompletions(
  input: string,
  setInput: (value: string) => void,
  projectPath?: string,
): Completions {
  const [open, setOpen] = useState(false)
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
      /* 500 条足够用，多了既卡渲染也没人会翻到那么后面 */
      setFileMentions(files.slice(0, 500))
    })
    return () => {
      alive = false
    }
  }, [projectPath])

  const match = TRIGGER.exec(input)
  const options: CompletionOption[] = !match
    ? []
    : match[1] === '/'
      ? SLASH_COMMANDS.map((c) => ({ cmd: c.cmd, desc: c.desc }))
      : fileMentions.length > 0
        ? fileMentions
        : MENTIONS.map((m) => ({ name: m.name, desc: m.desc }))

  return {
    open,
    options,
    syncFromText: (text) => setOpen(TRIGGER.test(text)),
    close: () => setOpen(false),
    apply: (label) => {
      setInput(input.replace(/([/@])[^\s]*$/, `${label} `))
      setOpen(false)
    },
  }
}
