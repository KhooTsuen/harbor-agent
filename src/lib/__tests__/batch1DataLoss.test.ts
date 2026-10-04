import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   第 1 批：数据不可逆丢失（审计问题 5 / 13 / 22 / 27）

   这四条的共同点：**用户攒出来的东西没了就回不来**。所以按「会不会丢」来钉：

     5  备份清单里写的老路径早被改名了 → 记忆从来没被备到过，备份还照报成功
     13 首启的空壳备份（只有两个空目录）能被一键「恢复」= 清空当前全部对话与技能
     22 改标题整篇重写会话 → 写一半崩了截断文件；解不开的行被静默删掉
     27 记忆文件非原子写 + 解不开时静默归零 → 下一轮注入就把坏文件盖成空

   说明：会话与记忆的真实路径由 `paths.cjs` 算出来（仓库 data/），没有注入口，
   所以这一组会**碰仓库 data/ 里自己造的那几个文件**，跑完一律还原/删除（afterAll）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)
const SANDBOX = mkdtempSync(join(tmpdir(), 'harbor-batch1-'))

/*
 * ★ 这一组必须跑在**沙盒**里。会话 / 记忆 / 备份的真实路径由 paths.cjs 算出来，
 *   之前没有注入口 —— 它直接读写仓库的 data/，而 CI 是全新检出：
 *   `.gitignore` 里 `data/` 被忽略 → `data/config.json` 根本不存在
 *   → 「真备份一份」的断言前提不成立（备份只剩 sessions），CI 连红 9 次。
 *   `markPackaged` 就是那个注入口（DIRS 全是 getter，调完立刻生效）。
 */
const paths = require_(join(ROOT, 'electron/core/paths.cjs')) as {
  DIRS: { data: string }
  markPackaged: (base: string) => void
  ensureDirs: () => void
}
paths.markPackaged(SANDBOX)
paths.ensureDirs()
/* 备份清单里的这两项要真的存在且有内容，否则它们会进 skipped（本地以前是靠仓库 data/ 蒙对的） */
writeFileSync(join(paths.DIRS.data, 'config.json'), '{}\n', 'utf8')
writeFileSync(join(paths.DIRS.data, 'memory.json'), '{"items": []}\n', 'utf8')

const sessionIo = require_(join(ROOT, 'electron/core/session-io.cjs')) as {
  fileFor: (id: string) => string
  newId: () => string
  writeLines: (id: string, lines: unknown[]) => void
  writeMetaLine: (id: string, meta: Record<string, unknown>) => { ok: boolean; replaced?: boolean }
}
const sessionWrite = require_(join(ROOT, 'electron/core/session-write.cjs')) as {
  updateMeta: (id: string, patch: Record<string, unknown>) => Record<string, unknown> | null
  remove: (id: string) => { ok: boolean }
}

const madeSessions: string[] = []
/** 造一个会话文件（走真实写入链），返回 id */
const makeSession = (title: string) => {
  const id = sessionIo.newId()
  madeSessions.push(id)
  sessionIo.writeLines(id, [{ type: 'meta', id, title }])
  return id
}

afterAll(() => {
  for (const id of madeSessions) {
    try {
      sessionWrite.remove(id)
    } catch {
      /* 忽略 */
    }
    const tmp = `${sessionIo.fileFor(id)}.tmp-${process.pid}`
    if (existsSync(tmp)) rmSync(tmp)
  }
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('问题 22 / 改标题不再丢数据', () => {
  it('★ 只动第一行，后面每一行逐字节不变（含解不开的坏行）', () => {
    const id = makeSession('旧标题')
    const file = sessionIo.fileFor(id)
    const body = [
      '{"type":"message","role":"user","content":"第一句"}',
      'e1:this-is-not-openable-ciphertext',
      '{"type":"message","role":"assistant","content":"第二句"}',
    ]
    writeFileSync(file, `${readFileSync(file, 'utf8')}${body.join('\n')}\n`, 'utf8')

    const before = readFileSync(file, 'utf8').split('\n').slice(1).join('\n')
    const updated = sessionWrite.updateMeta(id, { title: '新标题' })
    expect(updated?.title).toBe('新标题')

    const after = readFileSync(file, 'utf8').split('\n')
    expect(after[0]).toContain('新标题')
    expect(after.slice(1).join('\n')).toBe(before)
    expect(readFileSync(file, 'utf8')).toContain('e1:this-is-not-openable-ciphertext')
  }, 30000)

  it('★ 第一行不是 meta（或解不开）时，把 meta 插到最前面，原字节一个不丢', () => {
    const id = sessionIo.newId()
    madeSessions.push(id)
    const file = sessionIo.fileFor(id)
    writeFileSync(
      file,
      'e1:unreadable-first-line\n{"type":"message","content":"活着的行"}\n',
      'utf8',
    )

    const r = sessionIo.writeMetaLine(id, { type: 'meta', id, title: '补一个 meta' })
    expect(r.ok).toBe(true)
    expect(r.replaced).toBe(false)

    const text = readFileSync(file, 'utf8')
    expect(text.split('\n')[0]).toContain('补一个 meta')
    expect(text).toContain('e1:unreadable-first-line')
    expect(text).toContain('活着的行')
  })

  it('不留 .tmp 半成品（原子写收尾）', () => {
    const id = makeSession('a')
    sessionWrite.updateMeta(id, { title: 'b' })
    expect(existsSync(`${sessionIo.fileFor(id)}.tmp-${process.pid}`)).toBe(false)
  })
})

describe('问题 27 / 记忆：原子写 + 坏文件留档', () => {
  const store = require_(join(ROOT, 'electron/core/memory-store.cjs')) as {
    add: (input: { content: string }) => { ok: boolean; error?: string }
    filePath: () => string
    list: () => unknown[]
  }
  const memPath = store.filePath()
  /* ★ 走沙盒：以前是 join(ROOT, 'data') —— CI 上没有那个目录，readdirSync 直接 ENOENT */
  const dataDir = join(SANDBOX, 'data')
  let snapshot: string | null = null

  beforeAll(() => {
    snapshot = existsSync(memPath) ? readFileSync(memPath, 'utf8') : null
  })

  afterAll(() => {
    if (snapshot === null) {
      if (existsSync(memPath)) rmSync(memPath)
    } else {
      writeFileSync(memPath, snapshot, 'utf8')
    }
    for (const f of readdirSync(dataDir)) {
      if (f.startsWith('memory.json.corrupt-')) rmSync(join(dataDir, f))
    }
  })

  it('★ 写盘不留 .tmp（走的是原子写）', () => {
    const r = store.add({ content: `第 1 批测试：正常一条（跑完会还原）${Date.now()}` })
    expect(r.ok).toBe(true)
    expect(existsSync(`${memPath}.tmp-${process.pid}`)).toBe(false)
  })

  it('★ 文件解不开：先留一份 .corrupt 副本，再记错误（不静默归零）', () => {
    const countKept = () =>
      readdirSync(dataDir).filter((f) => f.startsWith('memory.json.corrupt-')).length

    writeFileSync(memPath, '{"items": [ 这不是合法 JSON', 'utf8')
    const before = countKept()

    expect(store.list()).toEqual([]) // 读一次（内部走 load）

    expect(countKept()).toBe(before + 1)
  })
})

describe('问题 5 + 13 / 备份：清单改对 + 空壳滚不进来', () => {
  const scan = require_(join(ROOT, 'electron/core/backup-scan.cjs')) as {
    ITEMS: { name: string }[]
    hasContent: (p: string) => boolean
  }
  const backup = require_(join(ROOT, 'electron/core/backup.cjs')) as {
    create: (reason?: string) => { ok: boolean; name?: string; skipped?: boolean; items?: string[] }
    restore: (name: string) => { ok: boolean; error?: string }
    remove: (name: string) => { ok: boolean }
    list: () => { name: string; empty: boolean; missing: string[] }[]
  }
  /* ★ 同上：备份根也要指到沙盒，否则「刚建的备份」在仓库 data/ 下根本找不到 */
  const backupsRoot = join(SANDBOX, 'data', 'backups')

  it('★ 清单里是 memory.json，不是老路径 memory.md', () => {
    const names = scan.ITEMS.map((i) => i.name)
    expect(names).toContain('memory.json')
    expect(names).not.toContain('memory.md')
  })

  it('★ 空目录 / 空文件算「没内容」；有东西才算', () => {
    const emptyDir = join(SANDBOX, 'empty-dir')
    mkdirSync(emptyDir, { recursive: true })
    const emptyFile = join(SANDBOX, 'empty.txt')
    writeFileSync(emptyFile, '', 'utf8')
    const withFile = join(SANDBOX, 'with-file')
    mkdirSync(withFile, { recursive: true })
    writeFileSync(join(withFile, 'x.txt'), 'x', 'utf8')

    expect(scan.hasContent(emptyDir)).toBe(false)
    expect(scan.hasContent(emptyFile)).toBe(false)
    expect(scan.hasContent(withFile)).toBe(true)
    expect(scan.hasContent(join(SANDBOX, '不存在'))).toBe(false)
  })

  it('★ 空壳备份：列表标成 empty，且「恢复」被后端拒绝', () => {
    const name = `19700101-0000${String(Date.now() % 100).padStart(2, '0')}`
    const shell = join(backupsRoot, name)
    mkdirSync(join(shell, 'sessions'), { recursive: true })
    mkdirSync(join(shell, 'skills'), { recursive: true })
    writeFileSync(
      join(shell, 'meta.json'),
      JSON.stringify({ reason: 'auto', items: ['sessions', 'skills'], version: 1 }),
      'utf8',
    )
    try {
      const listed = backup.list().find((b) => b.name === name)
      expect(listed?.empty).toBe(true)
      expect(listed?.missing).toContain('config.json')

      const r = backup.restore(name)
      expect(r.ok).toBe(false)
      expect(String(r.error)).toContain('空壳')
    } finally {
      rmSync(shell, { recursive: true, force: true })
    }
  })

  it('★ 真备份一份：备到的项都真的有内容，没内容的项进 skipped', () => {
    const made = backup.create('selftest-batch1')
    try {
      expect(made.ok).toBe(true)
      expect(made.items).toContain('config.json')
      const dir = join(backupsRoot, String(made.name))
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
      expect(meta.items).toContain('config.json')
      expect(Array.isArray(meta.skipped)).toBe(true)
      for (const item of meta.items) expect(scan.hasContent(join(dir, item))).toBe(true)
      expect(statSync(dir).isDirectory()).toBe(true)
    } finally {
      if (made.name) backup.remove(made.name)
    }
    /*
     * 这条要真复制一份 data/ —— 而仓库里 sessions 是上千个小文件（每个都极小），
     * 全量并行跑时磁盘会很忙，默认 5 秒预算会被 I/O 挤爆（2026-10-04 推送前闸门就是这么红的）。
     * 这是「慢」不是「行为变了」：断言一个字没改，只放宽时间预算（与性能类测试同一做法）。
     */
  }, 30000)
})
