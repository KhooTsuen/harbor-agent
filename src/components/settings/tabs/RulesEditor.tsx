import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { colorOf } from '@/lib/statusLanguage'
import { cn } from '@/lib/utils'
import { projectRulesReadFile, projectRulesWriteFile, type RuleTarget } from '@/lib/projectRulesApi'

/* ══════════════════════════════════════════════════════════════
   应用内编辑项目规则（真机反馈 10）

   以前只能「在系统编辑器里打开」，改完还得回来点一次「重新加载」。
   现在设置页里直接改、点保存就完事（规则文件写完内核那边**立即重载**）。

   边界（重要，别在这里加路径）：
     界面只说「改哪一份」（`target` 符号），文件路径由内核自己拼 ——
     所以这里连一个能写到别处的路径都构造不出来。想加第三份文件，
     去改 `electron/handlers/project-rules.cjs` 的 `editors` 表。
   ══════════════════════════════════════════════════════════════ */

const TABS: Array<{ id: RuleTarget; label: string; hint: string }> = [
  { id: 'rules', label: '项目规则', hint: '.harbor/rules.md —— 这个项目的规矩，每轮都注入' },
  { id: 'agent', label: '项目说明', hint: 'AGENT.md —— 项目介绍，与规则拼在同一层' },
]

export function RulesEditor({
  open,
  dir,
  onClose,
  onSaved,
}: {
  open: boolean
  dir?: string
  onClose: () => void
  onSaved: () => void
}) {
  const [target, setTarget] = useState<RuleTarget>('rules')
  const [text, setText] = useState('')
  const [original, setOriginal] = useState('')
  const [file, setFile] = useState('')
  const [problem, setProblem] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  /* 打开、或者切换要编辑的那一份时，读一次 */
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setProblem('')
    void projectRulesReadFile(target, dir).then((res) => {
      if (!alive) return
      const content = res.ok ? (res.content ?? '') : ''
      if (!res.ok) setProblem(res.error || '读不到这个文件')
      setText(content)
      setOriginal(content)
      setFile(res.file ?? '')
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [open, target, dir])

  const dirty = text !== original
  const tab = TABS.find((t) => t.id === target)

  async function save(): Promise<void> {
    setSaving(true)
    setProblem('')
    const res = await projectRulesWriteFile(target, text, dir)
    setSaving(false)
    if (!res.ok) {
      setProblem(res.error || '保存失败')
      return
    }
    setOriginal(text)
    /* 规则文件内核已经**立即重载**（不等 mtime），外面只要刷一下状态 */
    onSaved()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="编辑项目规则"
      description={`${tab?.hint ?? ''}${file ? ` · ${file}` : ''}`}
      width="lg"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {dirty ? <span className="mr-auto text-2xs text-warning">有未保存的改动</span> : null}
          <Button variant="secondary" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            loading={saving}
            disabled={loading || !dirty}
            onClick={() => void save()}
          >
            保存
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTarget(item.id)}
              className={cn(
                'rounded-sm px-2 py-1 text-2xs transition-colors duration-fast',
                item.id === target
                  ? 'bg-bg-raised text-fg-primary'
                  : 'text-fg-secondary hover:bg-bg-hover',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {problem ? (
          <p className="text-2xs" style={{ color: colorOf('failed') }}>
            {problem}
          </p>
        ) : null}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label="文件内容"
          placeholder={loading ? '读取中…' : '（这个文件还不存在 —— 写下内容，保存就会新建）'}
          className="h-[min(52vh,460px)] w-full resize-none rounded-base border border-line-hairline bg-bg-input px-2.5 py-2 font-mono text-xs leading-relaxed text-fg-primary focus:border-line-focus focus:outline-none"
        />
      </div>
    </Modal>
  )
}
