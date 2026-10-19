import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CollabPicker } from '../composer/CollabPicker'

/* 供应商的模型列表要在用例里换（「只有一个可用模型」那种情形），所以放进 hoisted */
const h = vi.hoisted(() => ({ models: ['first-model', 'chosen-model'] }))
const toast = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; title: string }> }))

vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: (select: (state: unknown) => unknown) =>
    select({
      config: {
        providers: [
          {
            id: 'mock',
            name: '测试供应商',
            kind: 'openai',
            enabled: true,
            models: h.models,
          },
        ],
      },
    }),
}))

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (select: (state: unknown) => unknown) =>
    select({
      showToast: (kind: string, title: string) => {
        toast.calls.push({ kind, title })
      },
    }),
}))

const container = document.createElement('div')
const root = createRoot(container)
document.body.append(container)

beforeEach(() => {
  h.models = ['first-model', 'chosen-model']
  toast.calls = []
})

afterEach(() => {
  act(() => root.render(null))
})

function renderPicker(props: Partial<ComponentProps<typeof CollabPicker>> = {}): void {
  act(() => {
    root.render(
      <CollabPicker
        collab={null}
        model="chosen-model"
        reasoning="high"
        onModel={() => {}}
        onReasoning={() => {}}
        onChange={() => {}}
        {...props}
      />,
    )
  })
}

async function openPicker(): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
  expect(button).toBeDefined()
  await act(async () => {
    button?.click()
    await Promise.resolve()
  })
}

/** 底部那条切换按钮（文案 / aria-label 都认） */
function switchButton(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (button) =>
      button.getAttribute('aria-label') === '切换为双模型' ||
      button.getAttribute('aria-label') === '切换为单模型',
  ) as HTMLButtonElement | undefined
}

it('同一后端有多个模型时显示用户实际选择，不能总显示第一个模型', () => {
  renderPicker({
    collab: {
      planner: { kind: 'openai', model: 'chosen-model' },
      executor: { kind: 'openai', model: 'chosen-model' },
    },
  })
  const label = container.querySelector('button')?.textContent ?? ''
  expect(label).toContain('chosen-model')
  expect(label).not.toContain('first-model')
})

it('单模型状态显示供应商和当前供应商的模型列表', async () => {
  renderPicker()
  await openPicker()
  expect(document.body.textContent).toContain('测试供应商')
  expect(document.body.textContent).toContain('first-model')
  expect(document.body.textContent).toContain('chosen-model')
})

it('双模型状态显示 A/B 预览，并禁用另一角色已选模型', async () => {
  renderPicker({
    collab: {
      planner: { kind: 'openai', model: 'chosen-model' },
      executor: { kind: 'openai', model: 'first-model' },
    },
  })
  await openPicker()
  expect(document.body.textContent).toContain('模型 A 预览')
  expect(document.body.textContent).toContain('模型 B 预览')

  const blocked = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.disabled && button.textContent?.includes('first-model'),
  )
  expect(blocked).toBeDefined()
})

it('★ 只有一个可用模型时，切换条仍然可点 —— 点了说清缺什么，不是变灰没反应', async () => {
  h.models = ['only-model']
  renderPicker()
  await openPicker()

  const toggle = switchButton()
  expect(toggle).toBeDefined()
  expect(toggle?.disabled).toBe(false)

  await act(async () => {
    toggle?.click()
    await Promise.resolve()
  })
  expect(toast.calls.some((call) => call.title.includes('还不能用双模型'))).toBe(true)
})

it('有两个可用模型时，切换条点了就进双模型，并给 A/B 各选一个不同的模型', async () => {
  const onChange = vi.fn()
  renderPicker({ onChange })
  await openPicker()

  await act(async () => {
    switchButton()?.click()
    await Promise.resolve()
  })

  expect(onChange).toHaveBeenCalledTimes(1)
  const picked = onChange.mock.calls[0]?.[0] as {
    planner?: { model?: string }
    executor?: { model?: string }
  }
  expect(picked.planner?.model).toBeTruthy()
  expect(picked.executor?.model).toBeTruthy()
  expect(picked.planner?.model).not.toBe(picked.executor?.model)
})
