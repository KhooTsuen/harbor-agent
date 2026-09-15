import { useEffect, useState } from 'react'
import { FolderOpen, FileText, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { SkillInfo } from '@/types/backend'
import { createSkill, listSkills, openSkillsDir, removeSkill } from '@/lib/skillsApi'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 技能

   技能 = `data/skills/<名字>/SKILL.md`。系统提示里只放「名字 + 什么时候用 + 路径」，
   模型判断用得上时自己去读全文。

   所以这一页的重点是让 description 写对 —— 它是唯一决定「这个技能会不会被想起来」
   的东西，界面上也这么标出来。
   ══════════════════════════════════════════════════════════════ */

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftDesc, setDraftDesc] = useState('')

  const showToast = useUIStore((s) => s.showToast)
  const askPermission = useUIStore((s) => s.askPermission)

  async function refresh(): Promise<void> {
    setLoading(true)
    setSkills(await listSkills())
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function submitCreate(): Promise<void> {
    const name = draftName.trim()
    if (!name) return
    const result = await createSkill(name, draftDesc.trim())
    if (!result.ok) {
      showToast('error', '建技能失败', result.error)
      return
    }
    setCreating(false)
    setDraftName('')
    setDraftDesc('')
    await refresh()
    showToast('success', '技能已创建', '打开目录就能编辑 SKILL.md')
  }

  return (
    <div className="py-1">
      <SectionTitle>技能</SectionTitle>

      {loading ? (
        <p className="py-3 text-2xs text-fg-tertiary">读取中…</p>
      ) : skills.length === 0 ? (
        <p className="py-3 text-dense leading-relaxed text-fg-secondary">
          还没有技能。技能是一份 Markdown 操作手册，写一次之后每次遇到同类任务模型都能照着做。
        </p>
      ) : (
        <ul className="flex flex-col gap-2 py-2">
          {skills.map((skill) => (
            <li
              key={skill.id}
              className="rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <FileText size={14} className="mt-0.5 shrink-0 text-fg-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="text-dense text-fg-primary">{skill.name}</p>
                  <p className="mt-0.5 text-2xs leading-relaxed text-fg-secondary">
                    {skill.description}
                  </p>
                  <p className="mt-1 font-mono text-2xs text-fg-tertiary">
                    {skill.id} · 正文 {skill.bodyLength} 字
                    {skill.bodyLength === 0 ? '（空壳，模型读了也没用）' : ''}
                  </p>
                </div>
                <IconButton
                  label="删除这个技能"
                  size={28}
                  onClick={() =>
                    askPermission({
                      kind: 'clear-data',
                      title: `删除技能「${skill.name}」？`,
                      description: `会删掉 ${skill.dir}，不能撤销。`,
                      confirmText: '删除',
                      danger: true,
                      onConfirm: () => {
                        void (async () => {
                          const result = await removeSkill(skill.id)
                          if (result.ok) {
                            await refresh()
                            showToast('success', '技能已删除')
                          } else {
                            showToast('error', '删除失败', result.error)
                          }
                        })()
                      },
                    })
                  }
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Row
        label="新建技能"
        hint="description 决定模型会不会想起用它 —— 写「什么时候用」，别写「关于什么」"
      >
        {creating ? (
          <div className="flex flex-col gap-2">
            <Field
              value={draftName}
              onChange={setDraftName}
              placeholder="技能名，比如：检查打包体积"
              aria-label="技能名"
            />
            <Field
              value={draftDesc}
              onChange={setDraftDesc}
              placeholder="什么时候用它，比如：当打包产物超过 500KB 时"
              aria-label="技能描述"
            />
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={() => void submitCreate()}>
                创建
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={13} />}
              onClick={() => setCreating(true)}
            >
              新建
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={13} />}
              onClick={() => void refresh()}
            >
              刷新
            </Button>
          </div>
        )}
      </Row>

      <Row label="打开技能目录" hint="直接在里面写 SKILL.md 也行，写完刷新一下就生效">
        <Button
          variant="secondary"
          size="sm"
          icon={<FolderOpen size={13} />}
          onClick={() => void openSkillsDir()}
        >
          打开
        </Button>
      </Row>

      <p className="mt-3 border-t border-line-hairline pt-3 text-2xs leading-relaxed text-fg-tertiary">
        技能正文<span className="text-fg-secondary">不会</span>一直占上下文：系统提示里只有名字和
        description，模型判断用得上时才去读全文。所以正文可以写详细一点。
      </p>
    </div>
  )
}
