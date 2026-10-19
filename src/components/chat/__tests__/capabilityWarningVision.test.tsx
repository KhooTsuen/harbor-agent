import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '@/types/backend'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useThreadStore } from '@/stores/useThreadStore'

/* ══════════════════════════════════════════════════════════════
   输入框下面的能力提示（2026-10-18 修的真不一致）

   钉的是**界面说不说实话**，不是长相：

     ① A 没视觉、B 有视觉 → 不能再报「无法读取图片」
        （内核 `prepareRoles` 本来就会拿 B 当视觉辅助；以前界面只算
        `scenes.ocr`，于是把能读的情况说成读不了，用户去配 OCR 白忙）
     ② 两个都没视觉且没配识图 → 必须明确说读不了
     ③ 单模型不受多模型语义污染（自己也读不了且没配 OCR → 说读不了）
     ④ Codex 坐 B 位时按 MCP 桥**真实运行态**说话（未启用就说改不了代码）

   为什么真渲染：本项目反复踩过「源码守卫断言到注释里的字」的坑。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root
let Component: typeof import('../composer/CapabilityWarning').CapabilityWarning

/** MCP 桥的运行态（主进程算出来的那份形状） */
let mcpState: Record<string, unknown> = {
  mcp: { enabled: false, source: 'config' },
  write: { enabled: false, source: 'config' },
  runTest: { enabled: false, source: 'config' },
  approval: { perRequest: true, ui: 'PermissionBar' },
  needsRestart: false,
  installedAt: 0,
}

beforeAll(async () => {
  /* bridge 是组件模块加载时取的那一份 —— 必须先把这个假桥装好再 import */
  ;(window as unknown as { workbench: unknown }).workbench = {
    codexMcpStatus: async () => ({ ok: true, state: mcpState }),
  }
  Component = (await import('../composer/CapabilityWarning')).CapabilityWarning
})

afterAll(() => {
  delete (window as unknown as { workbench?: unknown }).workbench
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useThreadStore.setState({ inputImages: [], inputFiles: [] })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** 造一份最小配置：两个供应商、视觉能力按参数给 */
function makeConfig(input: { aVision: boolean; bVision: boolean; ocr?: boolean }): AppConfig {
  const aModel = 'model-a'
  const bModel = 'model-b'
  const baseProvider = {
    baseUrl: 'https://api.example.com/v1',
    apiKey: '••••••••',
    chatPath: '/chat/completions',
    enabled: true,
    hasKey: true,
  }
  const providers = [
    { ...baseProvider, id: 'pa', name: 'A 家', models: [aModel] },
    { ...baseProvider, id: 'pb', name: 'B 家', models: [bModel] },
    ...(input.ocr ? [{ ...baseProvider, id: 'pocr', name: '识图家', models: ['ocr-model'] }] : []),
  ]
  const info = (vision: boolean) => ({
    caps: { vision },
    source: { vision: 'preset' },
    preset: 'test',
    presetNote: '',
  })
  return {
    providers,
    assistant: { model: aModel },
    scenes: input.ocr ? { ocr: { providerId: 'pocr', model: 'ocr-model' } } : {},
    capabilities: {
      dims: ['vision'],
      labels: { vision: '读图' },
      numeric: [],
      note: '测试矩阵',
      models: { [aModel]: info(input.aVision), [bModel]: info(input.bVision) },
      providers: {
        pa: { [aModel]: info(input.aVision) },
        pb: { [bModel]: info(input.bVision) },
        ...(input.ocr ? { pocr: { 'ocr-model': info(true) } } : {}),
      },
    },
  } as unknown as AppConfig
}

/** 装上配置 + 一条多模型对话 */
function mountCollab(input: {
  aVision: boolean
  bVision: boolean
  ocr?: boolean
  aKind?: string
  bKind?: string
}): void {
  const aKind = input.aKind ?? 'openai'
  const bKind = input.bKind ?? 'openai'
  useConfigStore.setState({ config: makeConfig(input) })
  useAppStore.setState({
    activeThreadId: 't1',
    threads: [
      {
        id: 't1',
        model: 'model-a',
        model2: undefined,
        settings: { allowTools: true },
        collab: {
          planner: { kind: aKind, model: 'model-a', providerId: 'pa' },
          executor: {
            kind: bKind,
            model: bKind === 'codex-cli' ? 'codex-cli' : 'model-b',
            providerId: bKind === 'codex-cli' ? 'pc' : 'pb',
          },
        },
        messages: [],
        projectId: '',
        title: 't',
        status: 'idle',
        mode: 'pair',
        reasoning: 'high',
        pinned: false,
        archived: false,
        tags: [],
        exportedAt: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  } as unknown as Parameters<typeof useAppStore.setState>[0])
  useThreadStore.setState({ inputImages: ['data:image/png;base64,AAA'] })
  act(() => root.render(<Component />))
}

function text(): string {
  return (container.textContent || '').replace(/\s+/g, ' ')
}

describe('能力提示 / 多模型读图（#15）', () => {
  it('★★★ A 没视觉、B 有视觉 → 不再报「无法读取图片」', async () => {
    await act(async () => {
      mountCollab({ aVision: false, bVision: true })
    })
    const shown = text()
    expect(shown).not.toContain('无法读取图片')
    expect(shown).toContain('另一个选中模型的视觉能力')
  })

  it('★★★ 反过来（B 没视觉、A 有视觉）也不报读不了', async () => {
    await act(async () => {
      mountCollab({ aVision: true, bVision: false })
    })
    expect(text()).not.toContain('无法读取图片')
  })

  it('★★★ 两个都没视觉、也没配识图 → 明确说读不了', async () => {
    await act(async () => {
      mountCollab({ aVision: false, bVision: false })
    })
    expect(text()).toContain('无法读取图片')
  })

  it('★★ 两个都没视觉但配了识图模型 → 说由识图模型转文字', async () => {
    await act(async () => {
      mountCollab({ aVision: false, bVision: false, ocr: true })
    })
    const shown = text()
    expect(shown).not.toContain('无法读取图片')
    expect(shown).toContain('已配置的识图模型')
  })
})

describe('能力提示 / 单模型不被多模型语义污染', () => {
  it('★ 单模型自己读不了且没配 OCR → 说读不了', async () => {
    useConfigStore.setState({ config: makeConfig({ aVision: false, bVision: true }) })
    useAppStore.setState({
      activeThreadId: 's1',
      threads: [
        {
          id: 's1',
          model: 'model-a',
          settings: { allowTools: true },
          messages: [],
          projectId: '',
          title: 's',
          status: 'idle',
          mode: 'pair',
          reasoning: 'high',
          pinned: false,
          archived: false,
          tags: [],
          exportedAt: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    } as unknown as Parameters<typeof useAppStore.setState>[0])
    useThreadStore.setState({ inputImages: ['data:image/png;base64,AAA'] })
    await act(async () => {
      root.render(<Component />)
    })
    expect(text()).toContain('无法读取图片')
  })
})

describe('能力提示 / Codex 在 B 位时按 MCP 运行态说话', () => {
  it('★★★ MCP 未启用 → 说当前无法改代码', async () => {
    mcpState = {
      mcp: { enabled: false, source: 'config' },
      write: { enabled: false, source: 'config' },
      runTest: { enabled: false, source: 'config' },
      approval: { perRequest: true, ui: 'PermissionBar' },
      needsRestart: false,
      installedAt: 0,
    }
    useThreadStore.setState({ inputImages: [], inputFiles: [] })
    await act(async () => {
      mountCollab({ aVision: true, bVision: true, bKind: 'codex-cli' })
    })
    expect(text()).toContain('MCP 工具桥未启用')
  })

  it('★★ MCP 与写入都启用 → 不再报未启用', async () => {
    mcpState = {
      mcp: { enabled: true, source: 'config' },
      write: { enabled: true, root: 'E:\\proj', rootValid: true, source: 'config' },
      runTest: { enabled: true, source: 'config' },
      approval: { perRequest: true, ui: 'PermissionBar' },
      needsRestart: false,
      installedAt: 0,
    }
    useThreadStore.setState({ inputImages: [], inputFiles: [] })
    await act(async () => {
      mountCollab({ aVision: true, bVision: true, bKind: 'codex-cli' })
    })
    expect(text()).not.toContain('MCP 工具桥未启用')
    expect(text()).toContain('通过 MCP 工具桥改代码')
  })
})
