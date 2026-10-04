import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   第 4 批：保留策略与孤儿快照（审计问题 1 / 3 / 4 / 10 / 11）

     1  `data/logs` 按天的旧文件永不删（主日志 / actions / 工具大输出）
     3  `data/events/<日期>.jsonl` 同样只增不减
     4  `logs/token-metrics.jsonl` 单文件无上限、无轮转
    10  `cache/prompt-diag/<id>.json` 删会话后成孤儿
    11  `data/crash` 崩溃转储无保留策略

   共同验收要求（用户 2026-10-04 点名）：**清理抛错不能影响启动** ——
   这一组把「喂坏路径 → 不抛、只 ok:false」和「接线处包了 try」两件都钉住。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)
const SANDBOX = mkdtempSync(join(tmpdir(), 'harbor-batch4-'))

/*
 * ★ 沙盒 + 时间预算（来由见 batch1DataLoss.test.ts 顶部）：
 *   这一组真写日志 / 事件 / 快照（全在 data/ 下），CI 上没有仓库 data/；
 *   而且它在做真文件 I/O，Linux runner 上 5 秒默认预算不够。
 */
const paths = require_(join(ROOT, 'electron/core/paths.cjs')) as {
  markPackaged: (base: string) => void
  ensureDirs: () => void
}
paths.markPackaged(SANDBOX)
paths.ensureDirs()
vi.setConfig({ testTimeout: 30000 })

const retention = require_(join(ROOT, 'electron/core/data-retention.cjs')) as {
  KEEP_DAYS: number
  CRASH_KEEP_MIN: number
  OUTPUT_KEEP_MIN: number
  MAIN_LOG_RE: RegExp
  ACTIONS_RE: RegExp
  EVENTS_RE: RegExp
  TOOL_OUTPUT_RE: RegExp
  pruneDaily: (o: unknown) => { ok: boolean; removed: string[]; kept: number; reason?: string }
  pruneByAge: (o: unknown) => { ok: boolean; removed: string[]; kept: number }
  rotateFile: (file: string, incoming?: number, maxBytes?: number) => boolean
  pruneAll: (o?: unknown) => Record<string, { ok: boolean; removed: string[] }>
}
const diagRetention = require_(join(ROOT, 'electron/core/diag-retention.cjs')) as {
  snapPathFor: (id: string) => string
  pruneOrphanDiags: (o?: unknown) => { ok: boolean; removed: string[] }
}
const contextDiag = require_(join(ROOT, 'electron/core/context-diag.cjs')) as {
  diagnose: (layers: unknown[], options: { sessionId: string }) => unknown
}
const sessionIo = require_(join(ROOT, 'electron/core/session-io.cjs')) as {
  newId: () => string
  writeLines: (id: string, lines: unknown[]) => void
}
const sessionWrite = require_(join(ROOT, 'electron/core/session-write.cjs')) as {
  remove: (id: string) => { ok: boolean }
}

const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8')
const DAY = 86_400_000
const madeSessions: string[] = []
let madeSnap = ''

afterAll(() => {
  for (const id of madeSessions) {
    try {
      sessionWrite.remove(id)
    } catch {
      /* 忽略 */
    }
  }
  if (madeSnap) {
    try {
      rmSync(madeSnap, { force: true })
    } catch {
      /* 忽略 */
    }
  }
  rmSync(SANDBOX, { recursive: true, force: true })
})

/** 造一个目录并写一批文件 */
const dirWith = (label: string, files: string[]) => {
  const dir = join(SANDBOX, label)
  mkdirSync(dir, { recursive: true })
  for (const name of files) writeFileSync(join(dir, name), 'x', 'utf8')
  return dir
}

describe('问题 1 / 3：按天文件保留 30 天（logs / events 同一套判据）', () => {
  it('过期的删掉，保留期内的留着，**最新那个永远留**', () => {
    const now = Date.UTC(2026, 9, 4)
    const day = (offset: number) => {
      const d = new Date(now - offset * DAY)
      const p = (n: number) => String(n).padStart(2, '0')
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    }
    const dir = dirWith('logs', [
      `${day(40)}.log`, // 过期
      `${day(31)}.log`, // 过期
      `${day(3)}.log`, // 留着
      'notes.txt', // 名字不认得 → 一个都不许碰
    ])
    const r = retention.pruneDaily({ dir, re: retention.MAIN_LOG_RE, now })
    expect(r.ok).toBe(true)
    expect(r.removed.sort()).toEqual([`${day(31)}.log`, `${day(40)}.log`].sort())
    expect(existsSync(join(dir, `${day(3)}.log`))).toBe(true)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  })

  it('★ 只有一份、而且它很老 → 照样留着（「一打开发现历史空了」防呆）', () => {
    const now = Date.UTC(2026, 9, 4)
    const dir = dirWith('logs-old', ['2020-01-01.log'])
    const r = retention.pruneDaily({ dir, re: retention.MAIN_LOG_RE, now })
    expect(r.removed).toEqual([])
    expect(existsSync(join(dir, '2020-01-01.log'))).toBe(true)
  })

  it('actions / events 各自的名字形状都认（日期从名字里取，不看 mtime）', () => {
    const now = Date.UTC(2026, 9, 4)
    const actions = dirWith('logs-actions', [
      'actions-2026-01-01.jsonl',
      'actions-2026-10-03.jsonl',
    ])
    const events = dirWith('events', ['2026-01-01.jsonl', '2026-10-03.jsonl'])
    expect(retention.pruneDaily({ dir: actions, re: retention.ACTIONS_RE, now }).removed).toEqual([
      'actions-2026-01-01.jsonl',
    ])
    expect(retention.pruneDaily({ dir: events, re: retention.EVENTS_RE, now }).removed).toEqual([
      '2026-01-01.jsonl',
    ])
    expect(existsSync(join(events, '2026-10-03.jsonl'))).toBe(true)
  })

  it('喂一个会抛的 re（外层 catch）→ 不抛、只 ok:false', () => {
    const dir = dirWith('logs-boom', ['2020-01-01.log'])
    const boom = {
      exec: () => {
        throw new Error('boom')
      },
    } as unknown as RegExp
    const r = retention.pruneDaily({ dir, re: boom, now: Date.now() })
    expect(r.ok).toBe(false)
    expect(r.removed).toEqual([])
  })

  it('目录不存在 → 如实返回「目录还不存在」，不报错（首启就是这种）', () => {
    const r = retention.pruneDaily({
      dir: join(SANDBOX, 'nope'),
      re: retention.MAIN_LOG_RE,
      now: Date.now(),
    })
    expect(r.ok).toBe(true)
    expect(r.reason).toContain('目录还不存在')
  })
})

describe('问题 1（工具大输出）/ 问题 11（崩溃转储）：按年龄 + 至少留 N 份', () => {
  it('工具大输出：过期删、但至少留最新 5 份', () => {
    const now = Date.UTC(2026, 9, 4)
    /* 12 份，各自 10~120 天前（全都超过 30 天）→ 删 7 留 5 */
    const names = Array.from(
      { length: 12 },
      (_, i) => `tool-output-${now - (i + 1) * 10 * DAY}.log`,
    )
    const dir = dirWith('tool-out', names)
    const r = retention.pruneByAge({
      dir,
      re: retention.TOOL_OUTPUT_RE,
      keepMin: retention.OUTPUT_KEEP_MIN,
      now,
    })
    /* 12 份全过期，但 keepMin=5 → 删 7 留 5 */
    expect(r.removed.length).toBe(7)
    expect(r.kept).toBe(5)
  })

  it('崩溃转储：只碰 .dmp，且至少留最新 3 份（用户自己放的东西不动）', () => {
    const now = Date.UTC(2026, 9, 4)
    const dir = dirWith('crash', [])
    for (let i = 1; i <= 6; i += 1) {
      writeFileSync(join(dir, `dump-${i}.dmp`), 'x', 'utf8')
      /* 干瘪的 mtime 一起改掉：假装它们都很老 */
      const old = new Date(now - (i + 40) * DAY)
      require_('node:fs').utimesSync(join(dir, `dump-${i}.dmp`), old, old)
    }
    writeFileSync(join(dir, 'README.txt'), 'x', 'utf8')
    const r = retention.pruneByAge({ dir, re: /\.dmp$/i, keepMin: retention.CRASH_KEEP_MIN, now })
    expect(r.removed.length).toBe(3)
    expect(existsSync(join(dir, 'README.txt'))).toBe(true)
    expect(existsSync(join(dir, 'dump-1.dmp'))).toBe(true)
  })
})

describe('问题 4：token-metrics 单文件超限轮转（和 6MB 同口径）', () => {
  it('超过上限 → 旧的改名 .1；没超 → 不动', () => {
    const file = join(SANDBOX, 'metrics.jsonl')
    writeFileSync(file, 'a'.repeat(100), 'utf8')
    expect(retention.rotateFile(file, 10, 60)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.1`)).toBe(true)

    writeFileSync(file, 'a'.repeat(10), 'utf8')
    expect(retention.rotateFile(file, 10, 60)).toBe(false)
    expect(existsSync(file)).toBe(true)
  })

  it('接线没断：recordRequest 里真的调了轮转（源码钉子）', () => {
    expect(read('electron/core/token-metrics.cjs')).toContain('retention.rotateFile(file()')
  })
})

describe('问题 10：删会话一并删诊断快照', () => {
  it('★ 路径算得和 context-diag 是**同一个文件**（真写一份再删）', () => {
    const id = sessionIo.newId()
    madeSessions.push(id)
    sessionIo.writeLines(id, [{ type: 'meta', id, title: '快照测试' }])

    /* 用 context-diag 自己的写入路径造一份快照（它的 snapFile 没导出，
       所以「两边算的是同一个文件」这件事只能这样证） */
    contextDiag.diagnose([{ id: 'coreIdentity', title: 'A', content: 'x' }], { sessionId: id })
    const snap = diagRetention.snapPathFor(id)
    expect(existsSync(snap)).toBe(true)

    sessionWrite.remove(id)
    expect(existsSync(snap)).toBe(false)
  })

  it('★ 无主快照（会话早就不在了）会被兜底扫掉；形状不像会话 id 的不碰', () => {
    const deadId = sessionIo.newId()
    contextDiag.diagnose([{ id: 'coreIdentity', title: 'A', content: 'y' }], { sessionId: deadId })
    const dir = join(require_(join(ROOT, 'electron/core/paths.cjs')).DIRS.chatCache, 'prompt-diag')
    const stray = join(dir, 'selftest-not-a-session.json')
    writeFileSync(stray, '{}', 'utf8')
    madeSnap = stray

    const r = diagRetention.pruneOrphanDiags()
    expect(r.removed).toContain(deadId)
    expect(existsSync(diagRetention.snapPathFor(deadId))).toBe(false)
    expect(existsSync(stray)).toBe(true)
  })
})

describe('共同验收：清理抛错也不能影响启动', () => {
  it('★ pruneAll 一把梭不抛，且每条都跑过（用临时目录，不碰真实 data）', () => {
    const now = Date.UTC(2026, 9, 4)
    const dirs = {
      logs: dirWith('all-logs', [
        '2026-01-01.log',
        '2026-10-03.log',
        'actions-2026-01-01.jsonl',
        `tool-output-${now - 60 * DAY}.log`,
      ]),
      events: dirWith('all-events', ['2026-01-01.jsonl', '2026-10-03.jsonl']),
      crash: dirWith('all-crash', ['a.dmp', 'b.dmp', 'c.dmp', 'd.dmp']),
      chatCache: join(SANDBOX, 'all-cache'),
      sessions: join(SANDBOX, 'all-sessions'),
    }
    mkdirSync(join(SANDBOX, 'all-sessions'), { recursive: true })
    /* 转储按名字认不出时间 → 看 mtime，所以得把 mtime 改老（不然「刚写的」就不该删） */
    for (const name of ['a.dmp', 'b.dmp', 'c.dmp', 'd.dmp']) {
      const old = new Date(now - 60 * DAY)
      require_('node:fs').utimesSync(join(dirs.crash, name), old, old)
    }

    const out = retention.pruneAll({ now, dirs })
    for (const key of [
      'logs.daily',
      'logs.actions',
      'logs.toolOutput',
      'events',
      'crash',
      'promptDiag',
    ]) {
      expect(out[key], key).toBeTruthy()
      expect(out[key].ok, key).toBe(true)
    }
    /* 真的删了（不是空转）：三处各至少一条 */
    expect(out['logs.daily'].removed).toContain('2026-01-01.log')
    expect(out.events.removed).toContain('2026-01-01.jsonl')
    expect(out.crash.removed.length).toBe(1)
    expect(existsSync(join(dirs.logs, '2026-10-03.log'))).toBe(true)
  })

  it('★ 接线处包了 try（源码钉子：boot-cleanup 里那句 pruneAll 在 try 内）', () => {
    const src = read('electron/boot-cleanup.cjs')
    expect(src).toContain("require('./core/data-retention.cjs').pruneAll()")
    const at = src.indexOf('pruneAll()')
    expect(src.slice(Math.max(0, at - 200), at)).toContain('try {')
    expect(src.slice(at, at + 200)).toContain('catch')
  })
})
