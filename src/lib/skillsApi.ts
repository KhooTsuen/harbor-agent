import type { SkillInfo } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   技能 API

   技能存在 data/skills/<名字>/SKILL.md，由主进程扫描。
   这里只做桥的包装，包一层的原因和其他 API 一样：失败不抛异常，
   统一返回 { ok, error }。
   ══════════════════════════════════════════════════════════════ */

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

export async function listSkills(): Promise<SkillInfo[]> {
  if (!bridge) return []
  try {
    return await bridge.listSkills()
  } catch {
    return []
  }
}

export async function createSkill(
  name: string,
  description: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持新建技能，请使用桌面版' }
  try {
    return await bridge.createSkill(name, description)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function removeSkill(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持删除技能，请使用桌面版' }
  try {
    return await bridge.removeSkill(id)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function openSkillsDir(): Promise<{ ok: boolean; dir?: string }> {
  if (!bridge) return { ok: false }
  try {
    return await bridge.openSkillsDir()
  } catch {
    return { ok: false }
  }
}
