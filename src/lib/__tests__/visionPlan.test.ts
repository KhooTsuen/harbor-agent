import { describe, expect, it } from 'vitest'
import type { ProviderCapabilityMatrix } from '@/types/backend'
import {
  providerOfRole,
  visionPlanFor,
  type VisionProviderLike,
  type VisionRoleLike,
} from '@/lib/modelCapabilityWarn'

/* ══════════════════════════════════════════════════════════════
   视觉路径判据（2026-10-18）

   钉的是**界面与内核同一口径**：后端 `core/collab-images.cjs` 的
   `prepareRoles` 在多模型时会拿另一个选中角色当视觉辅助，界面以前只算
   `scenes.ocr`，于是「A 能看图、B 不能、又没配 OCR」被误报成「无法读取图片」。

   这几条不联网、不发请求 —— 只判「按声明该走哪条路」。
   ══════════════════════════════════════════════════════════════ */

/** 造一份只含 vision 一个维度的能力矩阵 */
function matrix(entries: Record<string, { vision: boolean | null }>): ProviderCapabilityMatrix {
  const models: Record<string, unknown> = {}
  const providers: Record<string, Record<string, unknown>> = {}
  for (const [key, caps] of Object.entries(entries)) {
    const [providerId, model] = key.split('::')
    const info = {
      caps: { vision: caps.vision },
      source: { vision: 'preset' },
      preset: 'test',
      presetNote: '测试预设',
    }
    if (!providers[providerId]) providers[providerId] = {}
    providers[providerId][model] = info
    models[model] = info
  }
  return { labels: { vision: '读图' }, models, providers } as unknown as ProviderCapabilityMatrix
}

function provider(patch: Partial<VisionProviderLike> = {}): VisionProviderLike {
  return {
    id: 'p1',
    kind: 'openai',
    enabled: true,
    baseUrl: 'https://api.example.com/v1',
    hasKey: true,
    models: ['vision-model', 'text-model'],
    ...patch,
  }
}

const role = (patch: Partial<VisionRoleLike> = {}): VisionRoleLike => ({
  label: '当前助手',
  kind: 'openai',
  model: 'vision-model',
  providerId: 'p1',
  ...patch,
})

describe('visionPlanFor / 单模型', () => {
  it('模型自己有视觉 → 原图直接给它', () => {
    const plan = visionPlanFor({
      role: role(),
      matrix: matrix({ 'p1::vision-model': { vision: true } }),
      providers: [provider()],
    })
    expect(plan).toEqual({ mode: 'direct', via: 'self' })
  })

  it('模型没视觉但配了识图模型 → 走 ocr', () => {
    const plan = visionPlanFor({
      role: role({ model: 'text-model' }),
      matrix: matrix({
        'p1::text-model': { vision: false },
        'p2::ocr-model': { vision: true },
      }),
      providers: [provider(), provider({ id: 'p2', models: ['ocr-model'] })],
      ocr: { providerId: 'p2', model: 'ocr-model' },
    })
    expect(plan).toEqual({ mode: 'helper', via: 'ocr' })
  })

  it('模型没视觉、也没配识图 → 读不了（这条要给用户看）', () => {
    const plan = visionPlanFor({
      role: role({ model: 'text-model' }),
      matrix: matrix({ 'p1::text-model': { vision: false } }),
      providers: [provider()],
    })
    expect(plan).toEqual({ mode: 'none', via: '' })
  })

  it('能力未知（null）不算能读图 —— 不猜', () => {
    const plan = visionPlanFor({
      role: role(),
      matrix: matrix({ 'p1::vision-model': { vision: null } }),
      providers: [provider()],
    })
    expect(plan.mode).toBe('none')
  })
})

describe('visionPlanFor / 多模型（这次修的 bug）', () => {
  /** A 不能读图、B 能 —— 以前界面会说「无法读取图片」，其实 B 能帮忙 */
  const twoModels = matrix({
    'p1::text-model': { vision: false },
    'p1::vision-model': { vision: true },
  })

  it('★★★ A 没视觉但另一个选中角色有 → 由它转成文字（不再误报读不了）', () => {
    const plan = visionPlanFor({
      role: role({ label: 'A 指导/验收', model: 'text-model' }),
      others: [role({ label: 'B 执行', model: 'vision-model' })],
      matrix: twoModels,
      providers: [provider()],
    })
    expect(plan).toEqual({ mode: 'helper', via: 'role' })
  })

  it('★★★ 反过来也成立（B 没视觉、A 有）', () => {
    const plan = visionPlanFor({
      role: role({ label: 'B 执行', model: 'text-model' }),
      others: [role({ label: 'A 指导/验收', model: 'vision-model' })],
      matrix: twoModels,
      providers: [provider()],
    })
    expect(plan).toEqual({ mode: 'helper', via: 'role' })
  })

  it('★★ 两个都没视觉、但配了识图模型 → 走 ocr（不是 role）', () => {
    const plan = visionPlanFor({
      role: role({ label: 'A', model: 'text-model' }),
      others: [role({ label: 'B', model: 'text-model' })],
      matrix: matrix({
        'p1::text-model': { vision: false },
        'p2::ocr-model': { vision: true },
      }),
      providers: [
        provider({ models: ['text-model'] }),
        provider({ id: 'p2', models: ['ocr-model'] }),
      ],
      ocr: { providerId: 'p2', model: 'ocr-model' },
    })
    expect(plan).toEqual({ mode: 'helper', via: 'ocr' })
  })

  it('★★★ 都没有 → none（这条才是真的读不了）', () => {
    const plan = visionPlanFor({
      role: role({ label: 'A', model: 'text-model' }),
      others: [role({ label: 'B', model: 'text-model' })],
      matrix: matrix({ 'p1::text-model': { vision: false } }),
      providers: [provider({ models: ['text-model'] })],
    })
    expect(plan).toEqual({ mode: 'none', via: '' })
  })

  it('★ 辅助角色缺 Key / 缺地址就不算数（与内核 visionTarget 同口径）', () => {
    const plan = visionPlanFor({
      role: role({ label: 'A', model: 'text-model' }),
      others: [role({ label: 'B', model: 'vision-model' })],
      matrix: twoModels,
      providers: [provider({ hasKey: false })],
    })
    expect(plan.mode).toBe('none')
  })
})

describe('visionPlanFor / codex-cli 的边界', () => {
  it('★★★ codex-cli 即使被手填 vision:true 也不直接收图（内核只认 openai）', () => {
    const plan = visionPlanFor({
      role: role({ kind: 'codex-cli', model: 'codex-cli', providerId: 'pc' }),
      matrix: matrix({ 'pc::codex-cli': { vision: true } }),
      providers: [provider({ id: 'pc', kind: 'codex-cli', models: ['codex-cli'] })],
    })
    expect(plan.mode).toBe('none')
  })

  it('★ codex-cli 也能用另一个 openai 角色的视觉当辅助', () => {
    const plan = visionPlanFor({
      role: role({ label: 'B 执行', kind: 'codex-cli', model: 'codex-cli', providerId: 'pc' }),
      others: [role({ label: 'A 指导/验收', model: 'vision-model' })],
      matrix: matrix({
        'pc::codex-cli': { vision: false },
        'p1::vision-model': { vision: true },
      }),
      providers: [provider({ id: 'pc', kind: 'codex-cli', models: ['codex-cli'] }), provider()],
    })
    expect(plan).toEqual({ mode: 'helper', via: 'role' })
  })
})

describe('providerOfRole / 口径对齐 providerForRole', () => {
  const list = [provider(), provider({ id: 'pc', kind: 'codex-cli', models: ['codex-cli'] })]

  it('按 providerId 精确取', () => {
    expect(providerOfRole(list, role())?.id).toBe('p1')
  })

  it('没有 providerId → 取不到（不猜）', () => {
    expect(providerOfRole(list, role({ providerId: '' }))).toBeUndefined()
  })

  it('供应商已禁用 → 取不到', () => {
    expect(providerOfRole([provider({ enabled: false })], role())).toBeUndefined()
  })

  it('kind 与选择不一致 → 取不到', () => {
    expect(providerOfRole(list, role({ kind: 'codex-cli' }))).toBeUndefined()
  })

  it('模型已不在该供应商名下 → 取不到', () => {
    expect(providerOfRole(list, role({ model: 'gone-model' }))).toBeUndefined()
  })
})
