/**
 * 老版本数据迁移（浏览器 localStorage）
 *
 * 产品改过名，localStorage 的命名空间跟着变了：
 *   codex-workbench:app      → personal-agent:app
 *   codex-workbench:settings → personal-agent:settings
 *
 * **不能直接让用户丢数据。** 做法是最保守的那种：
 *   ① 新 key 已经存在 → 什么都不做（用户已经在新版本里用过）
 *   ② 否则把旧值原样复制到新 key
 *   ③ **旧 key 保留原样**，不删。万一新版本出了问题，回退旧版本还能用
 *
 * 必须在任何 store 被创建之前执行 —— 所以它是 main.tsx 里的第一个 import。
 * zustand 的 persist 在 store 创建时就会同步读一次 localStorage，
 * 晚了就来不及了。
 */

const MIGRATIONS: Array<[from: string, to: string]> = [
  ['codex-workbench:app', 'personal-agent:app'],
  ['codex-workbench:settings', 'personal-agent:settings'],
]

export function migrateLegacyStorage(): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return []

  const migrated: string[] = []

  for (const [from, to] of MIGRATIONS) {
    try {
      const existing = window.localStorage.getItem(to)
      if (existing !== null) continue

      const legacy = window.localStorage.getItem(from)
      if (legacy === null) continue

      window.localStorage.setItem(to, legacy)
      migrated.push(`${from} → ${to}`)
    } catch {
      /* 隐私模式 / 存储被禁用：跳过，不影响启动 */
    }
  }

  if (migrated.length > 0) {
    console.info('[migrate] 已迁移旧版存储：', migrated.join('、'))
  }
  return migrated
}

/* 在模块加载时就跑 —— main.tsx 第一个 import 它 */
migrateLegacyStorage()
