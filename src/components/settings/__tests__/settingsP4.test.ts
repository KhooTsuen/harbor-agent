import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   第四阶段守卫：权限与安全 / 工具与扩展 的分组与归属

   ── 为什么要有这一组 ──────────────────────────────────────────
   第一、二、三阶段各栽过一次「同一个组件被挂两次」：
     · 第一阶段：设置工作区 + 旧弹窗同时挂载 → 导航出现两遍
     · 第二阶段：GeneralPanel 与 GeneralTab 都挂 ShortcutsTab → 快捷键列两遍
     · 第三阶段：ConversationPanel 加了「定时任务」标题，SchedulesPanel 自己也有
   这一组把同样的判据（源码里只许出现一次挂载 + 每页标题不重复）钉到
   本轮新增的两个页面结构上。

   ★ 只看源码 + 剥注释：真机渲染的判据在 `settingsPagesRender.test.tsx` 与
     真机探针里，这里不重复。
   ══════════════════════════════════════════════════════════════ */

const ROOT = process.cwd()
const SETTINGS = join(ROOT, 'src', 'components', 'settings')

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
/** 去掉注释 —— 注释里提到组件名不算「渲染了它」（这坑前几轮踩过好几次） */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

/** 整个 settings 目录里，某个 JSX 标签被渲染了几次 */
function countMount(tag: string): { rel: string; count: number }[] {
  const out: { rel: string; count: number }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__') continue
        walk(full)
        continue
      }
      if (!full.endsWith('.tsx')) continue
      const code = strip(readFileSync(full, 'utf8'))
      const hits = code.split(new RegExp(`<${tag}[\\s/>]`)).length - 1
      if (hits > 0) out.push({ rel: full.slice(SETTINGS.length + 1), count: hits })
    }
  }
  walk(SETTINGS)
  return out
}

describe('第四阶段 / ① 权限与安全：四组各只挂一次', () => {
  const groups = [
    'AccessPolicyGroup',
    'AccessProtectionGroup',
    'AccessAuditGroup',
    'AccessAdvancedGroup',
  ]

  it('★★★ 四个分组组件在整页只各出现一次（不然同一份配置有两个编辑入口）', () => {
    for (const tag of groups) {
      const mounts = countMount(tag)
      const total = mounts.reduce((sum, m) => sum + m.count, 0)
      expect(total, `${tag} 被挂了 ${total} 次：${JSON.stringify(mounts)}`).toBe(1)
      expect(mounts[0].rel.replace(/\\/g, '/')).toBe('panels/AccessPanel.tsx')
    }
  })

  it('★★ 四个标签都在导航里，顺序固定', () => {
    const tabs = strip(read('src/components/settings/security/AccessTabs.tsx'))
    for (const label of ['权限策略', '数据与会话保护', '授权与审计', '高级与危险操作']) {
      expect(tabs, `缺 ${label}`).toContain(label)
    }
    const store = read('src/stores/useAccessTabStore.ts')
    expect(store).toContain("['policy', 'protection', 'audit', 'advanced']")
  })

  it('★ 标签状态住在组件外（切走再回来还在原来那组）', () => {
    const panel = strip(read('src/components/settings/panels/AccessPanel.tsx'))
    expect(panel).toContain('useAccessTabStore')
    expect(panel).not.toContain('useState')
  })
})

describe('第四阶段 / ② 权限与安全：老入口已清理', () => {
  it('★★★ 旧的 SecurityTab.tsx 已删（内容全拆进四组，留着就是第二套入口）', () => {
    expect(() => read('src/components/settings/tabs/SecurityTab.tsx')).toThrow()
  })

  it('★★ ToolsPanel 不再从模型页转出（它是权限页的东西）', () => {
    const models = strip(read('src/components/settings/panels/ModelsPanel.tsx'))
    expect(models).not.toContain('ToolsPanel')
    const provider = strip(read('src/components/settings/ProviderPanel.tsx'))
    expect(provider).not.toContain('export function ToolsPanel')
  })

  it('★★ 权限档位只有一处可改（PermissionLevelSummary 里的 radiogroup）', () => {
    const summary = strip(read('src/components/settings/security/PermissionLevelSummary.tsx'))
    expect(summary).toContain('role="radiogroup"')
    expect(summary).toContain('patchTools({ permission:')
    /* 别处不许再有一份 */
    const all = countMount('PermissionLevelSummary')
    expect(all.reduce((s, m) => s + m.count, 0)).toBe(1)
  })
})

describe('第四阶段 / ③ 权限与安全：真开关与「只读说明」分得开', () => {
  it('★★★ 会话加密是真开关（有真实读写通道，不是假开关）', () => {
    const crypto = strip(read('src/components/settings/panels/SessionCryptoPanel.tsx'))
    /* 真读写：读状态 + 写开关，两个都来自 sessionCryptoApi */
    expect(crypto).toContain('fetchSessionCrypto')
    expect(crypto).toContain('setSessionCrypto')
    expect(crypto).toContain('onChange={(e) => void toggle(')
  })

  it('★★★ 内核强制项不许做成开关（敏感文件 / 脱敏只说状态）', () => {
    const group = strip(read('src/components/settings/security/AccessProtectionGroup.tsx'))
    /* 这两个词出现的地方必须是说明，不能是 checkbox */
    expect(group).toContain('强制（无配置项）')
    expect(group).not.toMatch(/checkbox[^\n]*敏感文件/)
    expect(group).not.toMatch(/checkbox[^\n]*脱敏/)
  })

  it('★★ 当前有效授权与过去的审批分成两节（顺序：先能撤的）', () => {
    const audit = strip(read('src/components/settings/security/AccessAuditGroup.tsx'))
    /*
     * 2026-11-09：判据从「标题文字」改成「组件挂载顺序」。
     * 上一轮删掉了外面那个重复的「审批记录」标题（`ApprovalHistory` 自己带一个），
     * 于是这个文件里不再出现那四个字 —— 但**顺序要求没变**，只是载体换了。
     * 现在直接看三块谁先谁后：能撤的 → 历史 → 日志。
     */
    const grantAt = audit.indexOf('<GrantsPanel')
    const historyAt = audit.indexOf('<ApprovalHistory')
    const logAt = audit.indexOf('<AuditPanel')
    expect(grantAt, 'GrantsPanel 没挂上').toBeGreaterThan(-1)
    expect(historyAt, 'ApprovalHistory 没挂上').toBeGreaterThan(grantAt)
    expect(logAt, 'AuditPanel 没挂上').toBeGreaterThan(historyAt)
    /* 标题也还在（只是不再写「审批记录」，那个由组件自己带） */
    expect(audit).toContain('当前有效授权')
    expect(audit).toContain('审计日志')
  })
})

describe('第四阶段 / ④ 工具与扩展：三个能力区各只挂一次', () => {
  const groups = ['BrowserGroup', 'SkillsGroup', 'McpGroup']

  it('★★★ 三个分组组件各只挂一次，且都在 ExtensionPanel 里', () => {
    for (const tag of groups) {
      const mounts = countMount(tag)
      const total = mounts.reduce((sum, m) => sum + m.count, 0)
      expect(total, `${tag} 被挂了 ${total} 次`).toBe(1)
      expect(mounts[0].rel.replace(/\\/g, '/')).toBe('panels/ExtensionPanel.tsx')
    }
  })

  it('★★ 三个区域标签齐全', () => {
    const tabs = strip(read('src/components/settings/panels/ExtensionTabs.tsx'))
    for (const label of ['浏览器扩展', '技能', 'MCP 服务器']) expect(tabs).toContain(label)
    expect(read('src/stores/useExtensionTabStore.ts')).toContain("['browser', 'skills', 'mcp']")
  })

  it('★★★ 双模型协作与定时任务没有搬回扩展页（第三阶段已归位）', () => {
    const panel = strip(read('src/components/settings/panels/ExtensionPanel.tsx'))
    expect(panel).not.toContain('CollabPanel')
    expect(panel).not.toContain('SchedulesPanel')
  })

  it('★★★ MCP 权限分级只说现状，不做假开关', () => {
    const mcp = strip(read('src/components/settings/panels/McpGroup.tsx'))
    expect(mcp).toContain('内核未实现前这里不会显示成已生效')
    /* 不许出现「已保护 / 已授权」这类没有内核支撑的状态字 */
    expect(mcp).not.toContain('已保护')
  })
})

describe('第四阶段 / ⑤ 页面归属与索引一致', () => {
  it('★★ 13 页导航没变（还是 13 个）', () => {
    const nav = read('src/components/settings/settingsNav.ts')
    const ids = nav.match(/id: '[a-z]+'/g) ?? []
    expect(ids.length).toBe(13)
  })

  it('★★ 索引里每条都指向真实存在的页', () => {
    const nav = read('src/components/settings/settingsNav.ts')
    const valid = new Set((nav.match(/id: '([a-z]+)'/g) ?? []).map((s) => s.slice(5, -1)))
    for (const rel of ['settingsIndexBasic.ts', 'settingsIndexRest.ts']) {
      const src = read(`src/components/settings/${rel}`)
      for (const m of src.matchAll(/tab: '([a-z]+)'/g)) {
        expect(valid.has(m[1]), `${rel} 里的 ${m[1]} 不是真实页`).toBe(true)
      }
    }
  })

  it('★ 权限页新增的索引项指向 access', () => {
    const rest = read('src/components/settings/settingsIndexRest.ts')
    for (const label of ['当前权限状态', '会话内容加密', '当前有效授权', '风险试算']) {
      expect(rest, `索引缺「${label}」`).toContain(label)
    }
  })
})
