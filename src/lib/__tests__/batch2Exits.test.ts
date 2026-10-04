import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   第 2 批（下）：出口（审计问题 20 / 21 / 23 / 24）

    20 设置里的网络策略管不到 `browse`（`kind:'webview'` 分支没人调）
    21 网页标签**一个权限 handler 都没装** → 网页能直接要摄像头/录屏/剪贴板
    23 插件的权限门是 fail-open（没声明 = 白名单）、确认判断用 `!approval`
    24 任务结论与系统通知出口带着明文密钥出去

   边界那四条（14 / 15 / 16 / 17）在 batch2Bounds.test.ts。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)
const SANDBOX = mkdtempSync(join(tmpdir(), 'harbor-batch2b-'))

/*
 * ★ 沙盒 + 时间预算（来由见 batch1DataLoss.test.ts 顶部）：
 *   这一组会建任务（写 data/tasks），而 CI 上仓库根本没有 data/；
 *   再者批量 require 这些内核模块本身就慢，Linux runner 上 5 秒不够。
 */
const paths = require_(join(ROOT, 'electron/core/paths.cjs')) as {
  markPackaged: (base: string) => void
  ensureDirs: () => void
}
paths.markPackaged(SANDBOX)
paths.ensureDirs()
vi.setConfig({ testTimeout: 30000 })

const plugins = require_(join(ROOT, 'electron/core/plugins.cjs')) as {
  describePermissions: (permissions: unknown) => string
  pluginsDir: () => string
}
const toolsIndex = require_(join(ROOT, 'electron/core/tools/index.cjs')) as {
  execute: (name: string, args: Record<string, unknown>, ctx: unknown) => Promise<string>
}
const browse = require_(join(ROOT, 'electron/core/tools/browse.cjs')) as {
  networkGuard: (url: string, ctx: unknown) => string
}
const webviewPerm = require_(join(ROOT, 'electron/core/webview-permissions.cjs')) as {
  PARTITION: string
  decide: (permission: unknown) => boolean
  install: (ses: unknown, log?: unknown) => boolean
}
const taskCore = require_(join(ROOT, 'electron/core/task.cjs')) as {
  create: (options: Record<string, unknown>) => { id: string }
  finish: (id: string, options: Record<string, unknown>) => { result: string } | null
  remove: (id: string) => void
}

const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8')
const madeTasks: string[] = []

afterAll(() => {
  for (const id of madeTasks) {
    try {
      taskCore.remove(id)
    } catch {
      /* 忽略 */
    }
  }
})

describe('问题 20：browse 过网络策略（webview 分支）', () => {
  it('禁止模式 → 拦下', () => {
    const blocked = browse.networkGuard('http://example.com/a', { netPolicy: { mode: 'deny' } })
    expect(blocked).toContain('网络策略')
  })

  it('★ 禁止名单里的主机 → 拦下（策略是「先问」也一样）', () => {
    const blocked = browse.networkGuard('http://evil.example.com/a', {
      netPolicy: { mode: 'ask', denyHosts: ['evil.example.com'] },
    })
    expect(blocked).toContain('网络策略')
  })

  it('技能声明 network: deny → 拦下', () => {
    const blocked = browse.networkGuard('http://example.com/a', {
      netPolicy: { mode: 'allow' },
      networkGrant: 'deny',
    })
    expect(blocked).toContain('网络策略')
  })

  it('允许模式 → 放行；「先问」+ 需要确认档 → 交给上层弹框（转授权请求）', () => {
    expect(browse.networkGuard('http://example.com/a', { netPolicy: { mode: 'allow' } })).toBe('')
    expect(
      browse.networkGuard('http://example.com/a', {
        netPolicy: { mode: 'ask' },
        permission: 'ask',
      }),
    ).toBe('')
  })

  it('★ 「先问」+ 完全访问 → 拒（没人问就不能放行；2026-10-04 与 run_shell 统一）', () => {
    const blocked = browse.networkGuard('http://example.com/a', {
      netPolicy: { mode: 'ask' },
      permission: 'full',
    })
    expect(blocked).toContain('没人被问')
    expect(blocked).toContain('要放行')
  })
})

describe('问题 21：网页标签的权限闸（默认全拒）', () => {
  it('拿不到用户数据的放行，其余全拒', () => {
    for (const p of ['media', 'geolocation', 'clipboard-read', 'display-capture', 'unknown']) {
      expect(webviewPerm.decide(p)).toBe(false)
    }
    expect(webviewPerm.decide('fullscreen')).toBe(true)
    expect(webviewPerm.decide('clipboard-sanitized-write')).toBe(true)
  })

  it('两个 handler 都装上（request 与 check 各测一次回调）', () => {
    const asked: { permission: string; allow: boolean }[] = []
    const checked: { permission: string; allow: boolean }[] = []
    const fake = {
      setPermissionRequestHandler: (
        fn: (c: unknown, p: string, cb: (v: boolean) => void) => void,
      ) => {
        for (const permission of ['media', 'fullscreen']) {
          fn(null, permission, (allow: boolean) => asked.push({ permission, allow }))
        }
      },
      setPermissionCheckHandler: (fn: (c: unknown, p: string) => boolean) => {
        for (const permission of ['media', 'fullscreen']) {
          checked.push({ permission, allow: fn(null, permission) })
        }
      },
    }

    expect(webviewPerm.install(fake, { info: () => {} })).toBe(true)
    expect(asked).toEqual([
      { permission: 'media', allow: false },
      { permission: 'fullscreen', allow: true },
    ])
    expect(checked).toEqual([
      { permission: 'media', allow: false },
      { permission: 'fullscreen', allow: true },
    ])
  })

  it('拿不到 session 时如实返回 false（不装作装上了）', () => {
    expect(webviewPerm.install(null)).toBe(false)
  })

  it('分区名三处一致（前端 webview / 这个模块 / 主进程接线）', () => {
    expect(webviewPerm.PARTITION).toBe('persist:agent-browser')
    expect(read('src/components/layout/BrowserTab.tsx')).toContain(
      `partition="${webviewPerm.PARTITION}"`,
    )
    expect(read('electron/handlers/browser.cjs')).toContain(
      'webviewPermissions.install(session.fromPartition(webviewPermissions.PARTITION), log)',
    )
  })
})

describe('问题 23：插件权限 fail-closed', () => {
  it('一个字段都没声明时，描述里不写「无副作用」', () => {
    expect(plugins.describePermissions({})).toContain('未声明')
    /* 老口径不能改：明确写了 false 的才是「无副作用」 */
    expect(plugins.describePermissions({ network: false, write: false })).toBe('（无副作用）')
    expect(plugins.describePermissions({ network: true })).toBe('（联网）')
  })

  it('判定那边同一口径（源码钉子：未声明算有副作用、确认要 === true）', () => {
    const src = read('electron/core/tools/plugin-tool.cjs')
    expect(src).toContain('const declaredSafe = perm.network === false && perm.write === false')
    expect(src).toContain('const risky = !declaredSafe')
    expect(src).not.toContain('if (!approval)')
    expect(src).toContain('if (approval !== true)')
  })
})

/* 真跑一遍：造一个**不声明 permissions** 的插件，走完整的 tools.execute 流程。
   只钉源码的话，「未声明 = 有副作用」到底有没有生效根本不知道。 */
describe('问题 23：未声明权限的插件真的被当有副作用', () => {
  const dir = join(plugins.pluginsDir(), '_batch2_undeclared')
  const base = { workdir: ROOT, sessionId: 'batch2-selftest' }

  beforeAll(() => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify(
        { name_for_model: 'batch2_undeclared', name_for_human: '没声明权限的插件', runtime: {} },
        null,
        2,
      ),
    )
    writeFileSync(join(dir, 'run.cjs'), 'module.exports = { async run() { return "ran" } }\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('只读档下拦下', async () => {
    const out = await toolsIndex.execute(
      'batch2_undeclared',
      {},
      { ...base, permission: 'readonly' },
    )
    expect(String(out)).toContain('只读')
  })

  it('完全访问档照跑（没把它一棍子打死）', async () => {
    const out = await toolsIndex.execute('batch2_undeclared', {}, { ...base, permission: 'full' })
    expect(String(out)).toContain('ran')
  })

  it('★ 确认框返回非 true 的真值不算同意', async () => {
    const out = await toolsIndex.execute(
      'batch2_undeclared',
      {},
      { ...base, permission: 'ask', confirm: async () => 'yes' },
    )
    expect(String(out)).toContain('用户拒绝')
  })

  it('确认框返回 true 才算同意', async () => {
    const out = await toolsIndex.execute(
      'batch2_undeclared',
      {},
      { ...base, permission: 'ask', confirm: async () => true },
    )
    expect(String(out)).toContain('ran')
  })
})

describe('问题 24：结论/通知出口脱敏', () => {
  it('★ 任务结论里的密钥写进台账前就打码了', () => {
    const secret = ['sk-', 'B'.repeat(40)].join('')
    const task = taskCore.create({ goal: '第2批：结论脱敏', sessionId: 'batch2-selftest' })
    madeTasks.push(task.id)

    const finished = taskCore.finish(task.id, {
      status: 'completed',
      result: `做完了，用的 key 是 ${secret}`,
    })
    expect(String(finished?.result)).not.toContain(secret)
    expect(String(finished?.result)).toContain('已隐藏')
  })

  it('通知出口两处都过 redact（源码钉子）', () => {
    const src = read('electron/handlers/notify.cjs')
    expect(src).toContain('redact.redact(String(title ?? ')
    expect(src).toContain('redact.redact(String(body ?? ')
  })
})
