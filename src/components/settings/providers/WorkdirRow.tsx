import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useConfigStore } from '@/stores/useConfigStore'
import { Button } from '@/components/ui/Button'

/* ══════════════════════════════════════════════════════════════
   工作目录那一行（真机反馈 2）

   从 ToolsPanel 里搬出来的：那边贴着 300 行了，而这一行自己就够完整
   （显示 + 手填 + 选目录 + 恢复默认）。

   三条口径：
     · **输入框里是「配置值」**（`general.workdir`），不是「当前生效的目录」。
       生效目录是解析出来的（没配就是默认的 data/chat）—— 要是把解析结果塞进输入框，
       用户随便点一下别处（失焦提交）就把默认值**钉死**在配置里，以后回不到默认。
     · 生效目录单独一行小字写清楚，别让人猜「现在到底在用哪儿」。
     · 恢复默认 = 把 `general.workdir` 清空，不是帮他挑一个目录。
   ══════════════════════════════════════════════════════════════ */

export function WorkdirRow() {
  const config = useConfigStore((s) => s.config)
  const patchGeneral = useConfigStore((s) => s.patchGeneral)
  const workdir = useConfigStore((s) => s.workdir)
  const chooseWorkdir = useConfigStore((s) => s.chooseWorkdir)

  const configured = config?.general?.workdir ?? ''
  const [draft, setDraft] = useState(configured)
  const [picking, setPicking] = useState(false)

  /* 点了「换一个」挑了目录之后（或别处改了配置），输入框要跟上 */
  useEffect(() => setDraft(configured), [configured])

  function commit(): void {
    const next = draft.trim()
    if (next === configured) return
    void patchGeneral({ workdir: next })
  }

  return (
    <div className="acrylic-card rounded-base px-3.5 py-3">
      <p className="mb-1 text-2xs text-fg-tertiary">工作目录（模型看到的「相对路径」是相对这里）</p>
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          /* 失焦也提交：填完路径顺手点别处是很自然的动作，不该白填 */
          onBlur={commit}
          placeholder="留空 = 用默认目录"
          aria-label="工作目录"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-base border border-line-hairline bg-bg-raised/30 px-2.5 py-1.5 font-mono text-xs text-fg-secondary focus:border-line-focus focus:outline-none"
        />
        <Button
          size="sm"
          variant="secondary"
          loading={picking}
          icon={<FolderOpen size={13} />}
          onClick={() => {
            setPicking(true)
            void chooseWorkdir().finally(() => setPicking(false))
          }}
        >
          换一个
        </Button>
        {configured ? (
          <Button size="sm" variant="ghost" onClick={() => void patchGeneral({ workdir: '' })}>
            恢复默认
          </Button>
        ) : null}
      </div>
      <p className="mt-1.5 truncate font-mono text-2xs text-fg-tertiary" title={workdir}>
        当前生效：{workdir || 'data/chat（默认）'}
      </p>
    </div>
  )
}
