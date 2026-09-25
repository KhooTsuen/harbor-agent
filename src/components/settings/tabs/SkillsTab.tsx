import { useEffect, useState } from 'react'
import { FolderOpen, FileText, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { SkillRow } from '@/types/skills'
import { createSkill, listSkills, openSkillsDir, removeSkill } from '@/lib/skillsApi'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 技能

   技能 = `data/skills/<名字>/SKILL.md`。系统提示里只放「名字 + 什么时候用 + 路径
   + 权限声明」，模型判断用得上时自己去读全文。

   所以这一页的重点是让 description 写对 —— 它是唯一决定「这个技能会不会被想起来」
   的东西，界面上也这么标出来。

   技能还能在 frontmatter 里写 `permissions:`（文件 / Shell / 网络）。词和标签都由
   主进程算好（`electron/core/skill-permissions.cjs`），这里只负责摆出来 ——
   **不要在渲染层再写一套权限词**，不然两处会漂。
   ══════════════════════════════════════════════════════════════ */

/**
 * 一个技能声明的权限（一行小字，不重做布局）。
 *
 * ⚠️ `file` / `shell` 两档是**声明，不是强制**（`network` 那一档在用户把这个技能
 * 钉到某次会话之后由内核强制执行，见 `core/skill-pin.cjs`）。界面上不能只显示
 * 「网络 禁止」就让人以为真拦住了，所以文件底部那段免责说明是必须的，不是装饰。
 */
function SkillPermissionLine({ skill }: { skill: SkillRow }) {
  const error = typeof skill.permissionError === 'string' ? skill.permissionError : ''
  const permissions = skill.permissions
  const items = permissions && Array.isArray(permissions.items) ? permissions.items : []

  /* 写错了就说写错了 —— 不能装作没这回事（后端也是拒绝、不是忽略） */
  if (error) {
    return (
      <p className="mt-1 text-dense leading-relaxed text-danger">
        权限声明无效，已按「没声明」处理：{error}
      </p>
    )
  }

  if (items.length === 0) {
    return <p className="mt-1 text-dense text-fg-tertiary">权限：没声明（按当前权限档走）</p>
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <span className="text-2xs text-fg-tertiary">声明</span>
      {items.map((item) => (
        <span
          key={item.kind}
          className="rounded-sm bg-bg-surface px-1.5 py-0.5 text-2xs text-fg-secondary"
        >
          {item.label}
        </span>
      ))}
    </div>
  )
}

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillRow[]>([])
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
    <div className="flex flex-col gap-2 py-1">
      <SectionTitle>技能</SectionTitle>

      {loading ? (
        <p className="py-3 text-dense text-fg-tertiary">读取中…</p>
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
                  <p className="mt-0.5 text-dense leading-relaxed text-fg-secondary">
                    {skill.description}
                  </p>
                  <p className="mt-1 font-mono text-2xs text-fg-tertiary">
                    {skill.id} · 正文 {skill.bodyLength} 字
                    {skill.bodyLength === 0 ? '（空壳，模型读了也没用）' : ''}
                  </p>
                  <SkillPermissionLine skill={skill} />
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

      <p className="mt-3 border-t border-line-hairline pt-3 text-dense leading-relaxed text-fg-tertiary">
        技能里的权限分两种：<span className="text-fg-secondary">file / shell 两档只是声明</span>
        —— 它只跟着技能清单进系统提示、在这里给你看一眼，
        <span className="text-fg-secondary">拦不住任何一次工具调用</span>
        （写了「不碰文件」，工具照样可能去写）。
        <span className="text-fg-secondary">network 那一档不一样</span>
        ：在「设置 → 对话 → 本次会话」里把这个技能指定给某次会话之后，
        它的网络声明由内核在发起网络请求前强制执行，`deny` 优先于全局网络设置，
        而且这个会话的正文会一起进系统提示。 真正拦人的门始终在工具层：权限档（只读 / 每次确认 /
        完全）、文件范围、 Shell 风险分级，都在「权限与安全」里配。
      </p>

      <p className="mt-3 border-t border-line-hairline pt-3 text-dense leading-relaxed text-fg-tertiary">
        技能正文<span className="text-fg-secondary">不会</span>一直占上下文：系统提示里只有名字和
        description，模型判断用得上时才去读全文。所以正文可以写详细一点。 权限写在 SKILL.md 开头的
        frontmatter 里，比如 `permissions:` 下面写 `- file: read`、 `- shell: ask`、`- network:
        deny`。
      </p>
    </div>
  )
}
