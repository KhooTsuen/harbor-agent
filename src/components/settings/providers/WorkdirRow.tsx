import { useEffect, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'

/* ══════════════════════════════════════════════════════════════
   默认工作目录（**全局默认值**）

   位置：设置 → 对话 的**最上面**（2026-10-31 第二阶段从「工具」页搬过来）。
   为什么搬：它管的是「没有指定目录的对话默认在哪儿开工」，
   是**对话层面**的全局默认，不是工具权限 —— 和「工具权限 / 命令超时」放一起
   只会让人以为它只影响命令。

   ── 三条口径（别改回去）──────────────────────────────────────
     · **输入框里是「配置值」**（`general.workdir`），不是「当前生效的目录」。
       生效目录是解析出来的（没配就是默认的 data/chat）—— 要是把解析结果塞进输入框，
       用户随便点一下别处（失焦提交）就把默认值**钉死**在配置里，以后回不到默认。
     · 生效目录单独一行小字写清楚，别让人猜「现在到底在用哪儿」。
     · 恢复默认 = 把 `general.workdir` 清空，不是帮他挑一个目录。

   ── 第二阶段：三路保存都要有结果反馈 ─────────────────────────
   手填 / 选目录 / 恢复默认走的仍然是两条底层调用（`patchGeneral` 与
   `pickWorkdir`），但**结果必须说出来**：
     · 成功 → 生效目录那行立刻变（手填后要回主进程重读，不能自己猜）
     · 失败 → 红字 + toast，并把输入框退回配置值（不留下一个假的「已保存」）
     · 取消选目录 → 什么都不说（用户自己取消的，不是错误）
   ══════════════════════════════════════════════════════════════ */

export function WorkdirRow() {
  const config = useConfigStore((s) => s.config)
  const patchGeneral = useConfigStore((s) => s.patchGeneral)
  const workdir = useConfigStore((s) => s.workdir)
  const chooseWorkdir = useConfigStore((s) => s.chooseWorkdir)
  const syncWorkdir = useConfigStore((s) => s.syncWorkdir)
  const showToast = useUIStore((s) => s.showToast)

  const configured = config?.general?.workdir ?? ''
  const [draft, setDraft] = useState(configured)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const saving = useRef<string | null>(null)

  /* 点了「选目录」挑了目录之后（或别处改了配置），输入框要跟上 */
  useEffect(() => {
    setDraft(configured)
    setError('')
  }, [configured])

  /** 保存一个值：成功就刷新生效目录，失败就退回配置值并说明 */
  async function save(next: string, okMessage: string): Promise<void> {
    if (next === configured || saving.current === next) return
    saving.current = next
    try {
      const ok = await patchGeneral({ workdir: next })
      if (!ok) {
        setDraft(useConfigStore.getState().config?.general?.workdir ?? '')
        setError('保存失败：目录没写进配置。检查数据目录权限后重试。')
        showToast('error', '工作目录没能保存', '配置没有改动，仍然用原来的目录')
        return
      }
      setError('')
      /* 生效目录只有主进程知道 —— 存完必须重读一次，界面不能自己猜 */
      const effective = await syncWorkdir()
      showToast('success', okMessage, effective || '默认目录')
    } finally {
      if (saving.current === next) saving.current = null
    }
  }

  async function pick(): Promise<void> {
    setPicking(true)
    try {
      const ok = await chooseWorkdir()
      if (ok) {
        setError('')
        showToast('success', '默认工作目录已更新')
      } else {
        /* 用户取消和真失败区分不了（桥只回 ok:false）—— 不打断他，留一条灰字 */
        setError('没有选中目录（或选择被取消）。当前仍用上面那个值。')
      }
    } finally {
      setPicking(false)
    }
  }

  return (
    <div className="acrylic-card">
      <p className="mb-1 text-2xs font-semibold text-fg-secondary">默认工作目录（全局默认）</p>
      <p className="mb-2 text-2xs leading-relaxed text-fg-tertiary">
        在「对话文件夹」里新建的对话用它自己的目录；
        <strong className="font-semibold">没挂目录的单独对话</strong>
        用这里的值。模型看到的「相对路径」都是相对这里。项目与当前对话里的设置不会改它。
      </p>
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save(draft.trim(), '默认工作目录已更新')
          }}
          /* 失焦也提交：填完路径顺手点别处是很自然的动作，不该白填 */
          onBlur={() => {
            const next = draft.trim()
            if (next !== configured) void save(next, '默认工作目录已更新')
          }}
          placeholder="留空 = 用默认目录"
          aria-label="默认工作目录"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-base border border-line-hairline bg-bg-raised/30 px-2.5 py-1.5 font-mono text-xs text-fg-secondary focus:border-line-focus focus:outline-none"
        />
        <Button
          size="sm"
          variant="secondary"
          loading={picking}
          icon={<FolderOpen size={13} />}
          onClick={() => void pick()}
        >
          换一个
        </Button>
        {configured ? (
          <Button size="sm" variant="ghost" onClick={() => void save('', '已恢复默认目录')}>
            恢复默认
          </Button>
        ) : null}
      </div>
      <p className="mt-1.5 truncate font-mono text-2xs text-fg-tertiary" title={workdir}>
        当前生效：{workdir || 'data/chat（默认）'}
      </p>
      {/*
        配置里写着 A、实际在用 B —— 只有一个原因：A 这个目录现在不存在
        （删了 / 移走了 / 换了机器）。这时只看「当前生效」那行会以为设置没保存成功，
        所以必须说明是**回落到**默认目录，而不是悄悄换了一个位置。
        判据在真机验收 T7b（把目录删掉再重启）。
      */}
      {configured && workdir && configured !== workdir ? (
        <p className="mt-1 text-2xs" style={{ color: 'var(--warning, var(--error))' }}>
          设置里填的目录现在不存在，已回落到上面的默认目录；把它改成一个存在的路径就会用回它。
        </p>
      ) : null}
      {error ? (
        <p className="mt-1 text-2xs" style={{ color: 'var(--error)' }}>
          {error}
        </p>
      ) : null}
    </div>
  )
}
