import { useEffect, useState } from 'react'
import { FolderOpen, Save } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { fsRead } from '@/lib/fsApi'
import { Button } from '@/components/ui/Button'
import { Row, SectionTitle } from '../parts'

export function ProjectContextTab() {
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const [instructions, setInstructions] = useState('')
  const [source, setSource] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    if (!project?.path) return
    void fsRead('AGENT.md').then((result) => {
      if (!alive) return
      if (result?.ok && result.text !== undefined) {
        setInstructions(result.text)
        setSource('AGENT.md')
      } else {
        setInstructions('')
        setSource('')
      }
    })
    return () => {
      alive = false
    }
  }, [project?.path])

  async function save(): Promise<void> {
    setSaving(true)
    /* AGENT.md 是项目维护者文件，真正写入仍由 Agent/文件工具完成；这里提供明确的可复制内容。 */
    await navigator.clipboard?.writeText(instructions)
    setSaving(false)
  }

  return (
    <div className="py-1">
      <SectionTitle>项目上下文</SectionTitle>
      <p className="py-2 text-dense text-fg-secondary">
        当前项目规则来自工作目录中的 AGENT.md。它只影响当前项目，不会污染其他项目。
      </p>
      <Row label="当前项目" hint="切换工作目录后重新读取">
        <div className="flex items-center gap-2 rounded-sm border border-line-subtle bg-bg-raised px-2 py-1.5 text-xs text-fg-secondary">
          <FolderOpen size={13} />
          <span className="truncate">{project?.path || '未选择项目'}</span>
        </div>
      </Row>
      <Row label="项目说明" hint={source ? `来源：${source}` : '未找到 AGENT.md，可由 Agent 创建'}>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={12}
          placeholder="# 项目规则\n\n测试命令、目录约定、不可修改的文件……"
          className="w-full resize-y rounded-sm border border-line-subtle bg-bg-raised px-2.5 py-2 font-mono text-xs text-fg-primary focus:border-line-focus focus:outline-none"
        />
      </Row>
      <div className="flex justify-end">
        <Button
          variant="secondary"
          size="sm"
          icon={<Save size={13} />}
          loading={saving}
          onClick={() => void save()}
        >
          复制项目说明
        </Button>
      </div>
    </div>
  )
}
