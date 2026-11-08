import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
    第三阶段 · 模型与服务商四标签 + 跨页迁移后「只有一个入口」

    ── 为什么这一组必须存在 ──────────────────────────────────────
    这个项目已经因为「同一个组件被挂两次」栽过两次：

      · 第一阶段：工作区和旧弹窗都用 `settingsOpen` 开关 → 导航出现两遍
      · 第二阶段：`GeneralPanel` 和 `GeneralTab` 各挂一次 `ShortcutsTab`
                  → 快捷键列表显示两遍（用户真机发现）

    第三阶段把场景模型、路由、失败回退、Agent 开关、协作、定时任务、
    压缩阈值、产物目录全都搬了家。**搬家最典型的错法就是「新地方加了、
    旧地方忘了删」** —— 于是同一份配置有两个可编辑入口。这组就是防它。

    ── 两层判据 ──────────────────────────────────────────────────
      ① 源码层：每个搬走的组件，全项目只被渲染一次（读文件数出现次数）
      ② 渲染层：真渲染四标签，每页只有它该有的东西
    ══════════════════════════════════════════════════════════════ */

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: false, bridge: undefined }
})

import { ModelsPanel } from '../panels/ModelsPanel'
import { useModelsTabStore, MODELS_TABS } from '@/stores/useModelsTabStore'
import { SETTINGS_INDEX } from '../settingsIndex'
import { SETTINGS_NAV } from '../settingsNav'

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** 走一遍 src/，只收 .tsx（组件），跳过测试文件 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      walk(full, out)
    } else if (entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}
const ALL_TSX = walk(join(ROOT, 'src', 'components')).map((f) => ({
  rel: f
    .replace(ROOT + '\\', '')
    .replace(ROOT + '/', '')
    .replace(/\\/g, '/'),
  src: readFileSync(f, 'utf8'),
}))

/** 某个组件标签在整个 src/components 下被渲染了几次（只看 <Tag，不看 import） */
function mountCount(tag: string): { total: number; where: string[] } {
  const where: string[] = []
  let total = 0
  for (const f of ALL_TSX) {
    const n = (f.src.match(new RegExp(`<${tag}[\\s/>]`, 'g')) ?? []).length
    if (n > 0) {
      total += n
      where.push(`${f.rel}×${n}`)
    }
  }
  return { total, where }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  /* 每个用例从「服务商」这个默认标签开始，别让上一个用例的标签漏过来 */
  useModelsTabStore.setState({ tab: 'providers' })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function draw(): Promise<string> {
  await act(async () => {
    root.render(<ModelsPanel />)
  })
  return container.textContent ?? ''
}

describe('第三阶段 / ① 四个主标签都在、按顺序、能切', () => {
  it('★★ 四个标签齐了，顺序固定', () => {
    expect([...MODELS_TABS]).toEqual(['providers', 'scenes', 'policy', 'collab'])
  })

  it('★★ 标签栏渲染出四个按钮，名字对得上', async () => {
    const text = await draw()
    for (const label of ['服务商', '模型与场景', '运行策略', '双模型协作']) {
      expect(text, `缺标签「${label}」`).toContain(label)
    }
    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs.length).toBe(4)
  })

  it('★ 选中态用 aria-selected 表达（读屏能认）', async () => {
    await draw()
    const selected = container.querySelectorAll('[role="tab"][aria-selected="true"]')
    expect(selected.length).toBe(1)
    expect(selected[0].textContent).toBe('服务商')
  })

  it('★★ 切到哪个标签，只有那一页的内容（不串页）', async () => {
    await draw()
    expect(container.textContent).toContain('已配置的服务商')

    act(() => useModelsTabStore.setState({ tab: 'scenes' }))
    await act(async () => {
      root.render(<ModelsPanel />)
    })
    const scenes = container.textContent ?? ''
    expect(scenes).toContain('场景模型')
    expect(scenes).not.toContain('已配置的服务商')
  })

  it('★ 标签状态住在组件外（切走再回来还在原来那页）', () => {
    act(() => useModelsTabStore.setState({ tab: 'collab' }))
    act(() => root.unmount())
    expect(useModelsTabStore.getState().tab).toBe('collab')
  })
})

/** 剥掉注释再判断 —— 文件头里的说明会提到旧组件名，那不是引用 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

describe('第三阶段 / ② 每项配置只有一个编辑入口（源码层）', () => {
  it('★★★ ScenesPanel 只被渲染一次（场景模型不能两处都能改）', () => {
    const { total, where } = mountCount('ScenesPanel')
    expect(total, where.join(' , ')).toBe(1)
  })

  it('★★★ AssistantSwitches 只被渲染一次（七个 Agent 开关只有一处）', () => {
    const { total, where } = mountCount('AssistantSwitches')
    expect(total, where.join(' , ')).toBe(1)
  })

  it('★★★ CollabPanel 只被渲染一次（双模型协作只有一处）', () => {
    const { total, where } = mountCount('CollabPanel')
    expect(total, where.join(' , ')).toBe(1)
  })

  it('★★★ SchedulesPanel 只被渲染一次（定时任务只有一处）', () => {
    const { total, where } = mountCount('SchedulesPanel')
    expect(total, where.join(' , ')).toBe(1)
  })

  it('★★★ CompactThresholdRow 只被渲染一次（压缩阈值只有一处）', () => {
    const { total, where } = mountCount('CompactThresholdRow')
    expect(total, where.join(' , ')).toBe(1)
  })

  it('★★★ 产物目录各只一处（生图 / 下载）', () => {
    for (const tag of ['ImageSaveTab', 'DownloadSaveTab']) {
      const { total, where } = mountCount(tag)
      expect(total, `${tag}: ${where.join(' , ')}`).toBe(1)
    }
  })

  it('★★ 旧的 ScenesTab 已经删干净（没有半死引用）', () => {
    const live = ALL_TSX.filter((f) => stripComments(f.src).includes('ScenesTab'))
    expect(
      live.map((f) => f.rel),
      live.map((f) => f.rel).join(' , '),
    ).toEqual([])
  })
})

describe('第三阶段 / ③ 助手人设去了「对话与任务」', () => {
  it('★★ 名字 / 回答深度 / 人设在这三样都在 AssistantPersona', () => {
    const src = read('src/components/settings/providers/AssistantPersona.tsx')
    for (const key of ['name', 'responseDepth', 'systemPrompt']) {
      expect(src, `缺 ${key}`).toContain(key)
    }
  })

  it('★★ 模型参数页不再有这三样（否则就是两处能改同一份配置）', () => {
    const src = stripComments(read('src/components/settings/providers/ModelParamsPanel.tsx'))
    expect(src).not.toContain('responseDepth')
    expect(src).not.toContain('systemPrompt')
  })

  it('★ 回答深度写明了两级覆盖（否则用户以为全局改了没生效）', () => {
    const src = read('src/components/settings/providers/AssistantPersona.tsx')
    expect(src).toContain('上下文与项目')
    expect(src).toMatch(/优先|覆盖/)
  })
})

describe('第三阶段 / ④ 搜索索引跟得上新位置', () => {
  it('★★ 每条索引都指向真实存在的页（不许有幽灵）', () => {
    const valid = new Set(SETTINGS_NAV.map((t) => t.id))
    for (const entry of SETTINGS_INDEX) expect(valid.has(entry.tab)).toBe(true)
  })

  it('★★ 新建索引的词能搜到正确页', () => {
    const byLabel = (label: string) => SETTINGS_INDEX.find((e) => e.label === label)
    expect(byLabel('场景模型')?.tab).toBe('models')
    expect(byLabel('自动路由')?.tab).toBe('models')
    expect(byLabel('失败重试与回退')?.tab).toBe('models')
    expect(byLabel('运行策略')?.tab).toBe('models')
    expect(byLabel('双模型协作')?.tab).toBe('models')
    expect(byLabel('定时任务')?.tab).toBe('conversation')
    expect(byLabel('压缩阈值')?.tab).toBe('context')
    expect(byLabel('生图保存目录')?.tab).toBe('data')
    expect(byLabel('下载保存目录')?.tab).toBe('data')
    expect(byLabel('助手名字')?.tab).toBe('conversation')
  })

  it('★★ 索引里没有同名的两页（同一项指向两个地方就是两个入口）', () => {
    const seen = new Map<string, string>()
    const dup: string[] = []
    for (const e of SETTINGS_INDEX) {
      const at = seen.get(e.label)
      if (at && at !== e.tab) dup.push(`${e.label}: ${at} vs ${e.tab}`)
      seen.set(e.label, e.tab)
    }
    expect(dup, dup.join(' , ')).toEqual([])
  })
})

describe('第三阶段 / ⑤ 13 页导航没被这一轮改坏', () => {
  it('★★ 仍是 13 页 5 组，id 不重复', () => {
    expect(SETTINGS_NAV.length).toBe(13)
    expect(new Set(SETTINGS_NAV.map((t) => t.id)).size).toBe(13)
    expect(new Set(SETTINGS_NAV.map((t) => t.group)).size).toBe(5)
  })

  it('★ 「模型与服务商」这一页还在（搬东西不能把页搬没）', () => {
    expect(SETTINGS_NAV.some((t) => t.id === 'models')).toBe(true)
  })
})
