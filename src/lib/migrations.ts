import type { Project, Thread } from '@/types'
import { ExportBundleSchema, ProjectSchema, ThreadSchema } from './importSchemas'

/* ══════════════════════════════════════════════════════════════
   数据导入与迁移

   两条原则：
     ① **能救就救** —— 单条线程坏了就跳过那一条，别让整个文件作废
     ② **说清发生了什么** —— 返回 warnings，界面上要能显示给用户

   为什么不用 try/catch 包住整体：导入的是别人的文件，
   报错信息要具体到「第几条线程的哪个字段」，否则用户没法修。
   ══════════════════════════════════════════════════════════════ */

/** 当前数据结构版本。加字段不改它，删/改字段名才 +1 */
export const CURRENT_VERSION = 1

export interface ImportResult {
  threads: Thread[]
  projects: Project[]
  /** 跳过了几条、为什么 */
  warnings: string[]
  /** 源文件里的版本号 */
  sourceVersion: number
}

/**
 * 迁移 + 校验一个导入包。
 *
 * @param raw 从 JSON 文件解析出来的原始对象
 */
export function migrateImport(raw: unknown): ImportResult {
  const warnings: string[] = []

  const bundle = ExportBundleSchema.safeParse(raw)
  if (!bundle.success) {
    return {
      threads: [],
      projects: [],
      warnings: ['文件结构不对：期望是一个包含 threads 数组的 JSON'],
      sourceVersion: 0,
    }
  }

  const { version: sourceVersion, threads: rawThreads, projects: rawProjects } = bundle.data

  if (sourceVersion > CURRENT_VERSION) {
    warnings.push(
      `文件版本（v${sourceVersion}）比当前程序（v${CURRENT_VERSION}）新，可能有字段读不出来`,
    )
  } else if (sourceVersion < CURRENT_VERSION) {
    warnings.push(`文件来自旧版本 v${sourceVersion}，已按当前格式迁移`)
    console.info(`[迁移] v${sourceVersion} → v${CURRENT_VERSION}`)
  }

  /* ── 线程 ── */
  const threads: Thread[] = []
  rawThreads.forEach((item, index) => {
    const parsed = ThreadSchema.safeParse(item)
    if (parsed.success) {
      threads.push(parsed.data)
    } else {
      const reason = parsed.error.issues[0]?.message ?? '格式不对'
      warnings.push(`第 ${index + 1} 条线程跳过：${reason}`)
    }
  })

  /* ── 项目 ── */
  const projects: Project[] = []
  for (const item of rawProjects ?? []) {
    const parsed = ProjectSchema.safeParse(item)
    if (parsed.success) projects.push(parsed.data)
  }

  /* 线程引用的项目不在导入包里 → 给它一个兜底项目，避免侧栏空空如也 */
  if (projects.length === 0 && threads.length > 0) {
    const fallbackId = threads[0]?.projectId || 'imported'
    projects.push({
      id: fallbackId,
      name: '导入的对话',
      description: '从文件导入',
      path: '',
      branch: 'main',
      icon: '',
      color: '',
      pinned: false,
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    for (const thread of threads) {
      if (!thread.projectId) thread.projectId = fallbackId
    }
  }

  return { threads, projects, warnings, sourceVersion }
}

/** 把导入结果合并进现有数据：id 冲突时给新的 id，不覆盖已有对话 */
export function mergeImport(
  existing: { threads: Thread[]; projects: Project[] },
  incoming: { threads: Thread[]; projects: Project[] },
): { threads: Thread[]; projects: Project[]; addedThreads: number; addedProjects: number } {
  const threadIds = new Set(existing.threads.map((t) => t.id))
  const projectIds = new Set(existing.projects.map((p) => p.id))

  const newProjects = incoming.projects.filter((p) => !projectIds.has(p.id))

  const newThreads = incoming.threads.map((thread) => {
    if (!threadIds.has(thread.id)) return thread
    /* id 撞了就换一个，避免覆盖用户现有的对话 */
    const fresh = `${thread.id}-imported-${Date.now().toString(36)}`
    return { ...thread, id: fresh, title: `${thread.title}（导入）` }
  })

  return {
    threads: [...newThreads, ...existing.threads],
    projects: [...newProjects, ...existing.projects],
    addedThreads: newThreads.length,
    addedProjects: newProjects.length,
  }
}
