import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { memorySupported } from '@/lib/memoryApi'
import { Row, SectionTitle } from '../parts'
import { MemoryExplainPanel } from '../panels/MemoryExplainPanel'
import { MemoryList } from './MemoryList'

/* ══════════════════════════════════════════════════════════════
   设置 → 记忆

   刻意做成**列表**：用户要能一条条看清「记住了什么、哪来的、什么时候记的」，
   还要能单独停用一条 —— 改一个字就整套重写的文本框做不到这些。

   ── 第二阶段：把「它什么时候会记、记了会怎样」提到最上面 ────────
   以前一进来就是「模型想记东西时」这个下拉，用户还没搞清楚记忆是什么
   就先被问一个策略。现在顺序是：

     ① 它记得什么（三条策略，只读说明）
     ② 这条记忆是怎么被挑中的（可展开，来自 MemoryExplainPanel）
     ③ 当前项目（记忆绑到哪个项目）
     ④ 写入策略（模型想记时 / 每轮注入几条）
     ⑤ 记忆列表（搜索、手动加、逐条停用删除）

   列表组件在 `MemoryList.tsx`（从这边拆出去的，原文件 298 行贴顶）。
   ══════════════════════════════════════════════════════════════ */

const POLICY = [
  {
    key: '记什么',
    text: '你说过的偏好、定下的方案、项目的硬性约束；模型自己提的只进候选，等你批过才生效。',
  },
  {
    key: '怎么用',
    text: '每轮按相关性挑几条注入提示，不是全塞进去 —— 塞太多会稀释注意力还烧 token。',
  },
  { key: '删得干净吗', text: '每条都能单独停用或删除；停用的不注入，但记录留着，随时能恢复。' },
]

export function MemoryTab() {
  const config = useConfigStore((s) => s.config)
  const patchMemory = useConfigStore((s) => s.patchMemory)
  const projectId = useAppStore((s) => s.activeProjectId)
  const project = useAppStore((s) => s.projects.find((item) => item.id === projectId))
  const [showSuperseded, setShowSuperseded] = useState(false)

  /*
   * 浏览器预览没有桥 —— **只把「列表」这一块换掉**，策略说明照旧显示。
   *
   * 第二阶段修：以前整页提前 return，于是预览形态下用户既看不到
   * 「它记得什么」，也看不到写入策略的说明 —— 一个只有一句话的空白页。
   * 说明是纯文本，没有任何理由依赖桌面桥。
   */
  const supported = memorySupported()
  const memory = config?.memory

  return (
    <>
      <SectionTitle hint="记忆会跨对话保留 —— 记错一条的影响比改错一个文件更久">
        它是怎么记住你的
      </SectionTitle>

      <div className="acrylic-card">
        <ul className="flex flex-col gap-2 text-dense leading-relaxed text-fg-secondary">
          {POLICY.map((row) => (
            <li key={row.key}>
              <span className="font-medium text-fg-primary">{row.key}：</span>
              {row.text}
            </li>
          ))}
        </ul>
      </div>

      <MemoryExplainPanel projectId={projectId} />

      <SectionTitle hint={project ? `绑定到「${project.name}」` : '需要先选择工作目录'}>
        当前项目
      </SectionTitle>

      <Row
        label="项目记忆绑到哪"
        hint={
          project
            ? `项目记忆只在这个项目里注入，其他项目看不到。`
            : '当前没有选中的项目 —— 手动加记忆时「当前项目」这一项会不可选，只会记成全局。'
        }
      >
        <span className="text-dense text-fg-primary">
          {project ? project.name : '（未选项目）'}
        </span>
      </Row>

      <SectionTitle hint="这两项决定「它能不能自己记」和「每轮塞几条进来」">写入策略</SectionTitle>

      <Row
        label="模型想记东西时"
        hint="「先问我」最安全：模型觉得该记住什么时会先征求你同意。让它自己记可能积下你没打算留的东西"
      >
        <select
          value={memory?.autoWrite ?? 'ask'}
          onChange={(e) =>
            void patchMemory({ autoWrite: e.target.value as 'auto' | 'ask' | 'off' })
          }
          className="rounded-sm border border-line-subtle bg-bg-input px-2 py-1.5 text-dense text-fg-primary focus:outline-none"
        >
          <option value="ask">先问我（推荐）</option>
          <option value="auto">让它自己记</option>
          <option value="off">不许写，只读</option>
        </select>
      </Row>

      <Row label="每轮注入几条" hint="按相关性挑，不是全塞。调大会稀释注意力，也费 token">
        <input
          type="number"
          min={1}
          max={50}
          value={memory?.injectLimit ?? 12}
          onChange={(e) => void patchMemory({ injectLimit: Number(e.target.value) || 12 })}
          className="w-20 rounded-sm border border-line-subtle bg-bg-input px-2 py-1.5 font-mono text-dense text-fg-primary focus:outline-none"
        />
      </Row>

      <SectionTitle hint="每一行都能单独停用或删除">记忆列表</SectionTitle>

      {supported ? (
        <MemoryList
          projectId={projectId}
          showSuperseded={showSuperseded}
          onSupersededChange={setShowSuperseded}
        />
      ) : (
        <p className="px-1 py-3 text-dense text-fg-secondary">
          记忆列表需要桌面版（浏览器预览里没有读取记忆的通道）。
        </p>
      )}
    </>
  )
}
