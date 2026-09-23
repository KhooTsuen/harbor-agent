import { useEffect, useState } from 'react'
import type { SkillRow } from '@/types/skills'
import { listSkills } from '@/lib/skillsApi'
import { Row } from '../parts'

/* ══════════════════════════════════════════════════════════════
   把技能钉到**本次会话**

   ★ 为什么这一行值得单独做：
     技能平时只是系统提示里的一份**清单**（名字 + 用途 + 路径），正文由模型按需去读 ——
     所以运行时不存「这次对话在用哪个技能」这个概念。而技能里写的
     `permissions: network: deny` 就是挂在这个概念上的，没有它就没有触发点，
     只能叫「声明，不是强制」。

     用户在这里明确选一个之后，那个概念就成立了：正文会进系统提示，
     它的 `network` 声明**由内核在发起网络动作前强制执行**（见 core/skill-pin.cjs）。

   ★ 界面上必须写清哪几档**没**变成强制 —— `file` / `shell` 两档仍然只是声明。
     写宽了等于骗用户给权限。
   ══════════════════════════════════════════════════════════════ */

export function SkillPinRow({
  pinned,
  onPick,
}: {
  pinned: string
  onPick: (id: string) => void
}) {
  const [skills, setSkills] = useState<SkillRow[]>([])

  useEffect(() => {
    let alive = true
    void listSkills().then((list) => {
      if (alive) setSkills(list)
    })
    return () => {
      alive = false
    }
  }, [])

  const current = skills.find((s) => s.id === pinned)
  /* 钉过但技能已经不在了（删了/改名了）—— 如实说一句，别装作没钉过 */
  const gone = Boolean(pinned) && skills.length > 0 && !current

  const grantText = ((): string => {
    const net = current?.permissions?.byKind?.network
    if (net === 'deny') return '这次对话会禁止联网（内核强制执行）'
    if (net === 'ask') return '这次对话的联网动作会先问过你'
    if (net === 'allow') return '这次对话允许联网'
    return '这个技能没有写网络声明，联网照全局设置'
  })()

  return (
    <Row
      label="按哪个技能做"
      hint="选定后：正文会进系统提示，它的网络声明由内核强制执行。file / shell 两档仍只是声明。"
    >
      <div className="flex flex-col gap-1">
        <select
          value={pinned}
          onChange={(e) => onPick(e.target.value)}
          className="rounded-sm border border-line-subtle bg-bg-raised px-2 py-1 text-xs text-fg-primary"
        >
          <option value="">不指定</option>
          {skills.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {pinned ? (
          <p className="text-2xs leading-relaxed text-fg-secondary">{grantText}</p>
        ) : null}

        {gone ? (
          <p className="text-2xs leading-relaxed text-fg-tertiary">
            原来指定的「{pinned}」现在找不到了（可能被删掉或改了名），这一轮按平时的方式来。
          </p>
        ) : null}
      </div>
    </Row>
  )
}
