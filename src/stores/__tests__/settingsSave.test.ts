import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   第二阶段的设置行为（不渲染界面，直接钉状态机）

   三件事，都是文档点名要求、而且**真的出过错**的：
     ① 两处「重置设置」的结论必须如实 —— 后端失败时不能说全部成功
     ② 快速连续保存时，**较旧的回包不许覆盖较新的值**
     ③ 工作目录保存失败时，界面显示的值要退回配置值（不留假的「已保存」）

   ①的实现唯一源在 `lib/resetAllSettings.ts`；②③在 `stores/useConfigStore.ts`。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  /** pushConfig 的行为可以逐条改成「成功 / 失败」，也可以挂起（测并发顺序） */
  mode: 'ok' as 'ok' | 'fail' | 'hold',
  held: [] as Array<() => void>,
  resetOk: true,
  calls: [] as unknown[],
}))

vi.mock('@/lib/backend', () => ({
  isElectron: true,
  useRealBackend: true,
  bridge: undefined,
  loadConfig: async () => null,
  pingProvider: async () => ({ ok: true }),
  pickWorkdir: async () => ({ ok: true, workdir: 'E:/picked' }),
  getWorkdir: async () => 'E:/effective',
  resetConfig: async () => (h.resetOk ? { general: {} } : null),
  pushConfig: (patch: unknown) =>
    new Promise((resolve) => {
      h.calls.push(patch)
      const done = (): void =>
        resolve(
          h.mode === 'fail' ? null : { general: { workdir: 'E:/saved' }, ...(patch as object) },
        )
      if (h.mode === 'hold') h.held.push(done)
      else done()
    }),
  chooseFolder: async () => ({ ok: false }),
  saveText: async () => ({ ok: true }),
  /* setWorkdir → loadFromDisk 会用到这几个；这里只要它们不炸（本组不测磁盘读写） */
  listSessions: async () => [],
  loadSession: async () => null,
  removeSession: async () => ({ ok: true }),
  appendMessage: async () => ({ ok: true }),
}))

import { useConfigStore } from '@/stores/useConfigStore'
import { resetAllSettings } from '@/lib/resetAllSettings'
import { useSettingsStore } from '@/stores/useSettingsStore'

beforeEach(() => {
  h.mode = 'ok'
  h.held = []
  h.resetOk = true
  h.calls = []
})

describe('resetAllSettings · 后端失败不能报成功', () => {
  it('★ 后端重置失败 → outcome=partial，提示说清哪一半没成', async () => {
    h.resetOk = false
    const result = await resetAllSettings()
    expect(result.outcome).toBe('partial')
    /* 不能再出现「设置已重置」这种全成功口吻 */
    expect(result.message).not.toContain('设置已重置')
    expect(result.detail).toContain('没有重置成功')
  })

  it('两段都成功 → outcome=ok，并且提到对话数据不受影响', async () => {
    const result = await resetAllSettings()
    expect(result.outcome).toBe('ok')
    expect(result.detail).toContain('对话数据不受影响')
  })

  it('★ 即便后端失败，本地界面偏好也确实被重置了（不是「什么都没做」）', async () => {
    useSettingsStore.getState().updateSettings({ sidebarCollapsed: true })
    h.resetOk = false
    await resetAllSettings()
    expect(useSettingsStore.getState().settings.sidebarCollapsed).toBe(false)
  })
})

describe('useConfigStore · 保存与回包顺序', () => {
  it('保存成功返回 true，失败返回 false（调用方要能据此给话）', async () => {
    await expect(useConfigStore.getState().patchGeneral({ workdir: 'E:/a' })).resolves.toBe(true)
    h.mode = 'fail'
    await expect(useConfigStore.getState().patchGeneral({ workdir: 'E:/b' })).resolves.toBe(false)
  })

  it('★ 快速连改：较旧的回包后到，也不许覆盖较新的值', async () => {
    h.mode = 'hold'
    const first = useConfigStore.getState().patchGeneral({ workdir: 'E:/old' })
    const second = useConfigStore.getState().patchGeneral({ workdir: 'E:/new' })
    /* 故意让**先发的那次**后回 —— 这正是「被较旧结果覆盖」的场景 */
    h.held[1]()
    await second
    h.held[0]()
    await first

    expect(useConfigStore.getState().config?.general?.workdir).toBe('E:/new')
  })

  it('syncWorkdir 会读主进程的生效目录（手填之后界面不自己猜）', async () => {
    await expect(useConfigStore.getState().syncWorkdir()).resolves.toBe('E:/effective')
    expect(useConfigStore.getState().workdir).toBe('E:/effective')
  })

  it('resetToDefaults 失败时返回 false，成功时 true', async () => {
    h.resetOk = false
    await expect(useConfigStore.getState().resetToDefaults()).resolves.toBe(false)
    h.resetOk = true
    await expect(useConfigStore.getState().resetToDefaults()).resolves.toBe(true)
  })
})
