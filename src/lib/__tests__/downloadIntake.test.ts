import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   浏览器下载接管（2026-10-11）：网页里点「下载」→ 内置队列

   `core/download-intake.cjs` 不 require electron，所以这里能直接 require 它，
   拿假的 session / event / item 真跑一遍：
     · http/https 的被拦下 → 转成 `origin='browser'` 的任务（进内置队列）
     · blob: / data: 放行给 Chromium 自己的下载（只设保存路径，不拦）
   断言的是「拦谁、怎么命名、怎么接线」，不联网、不起 Electron。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)
const SANDBOX = mkdtempSync(join(tmpdir(), 'harbor-intake-'))

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

const intake = require_(join(ROOT, 'electron/core/download-intake.cjs')) as {
  isHttpUrl: (u: string) => boolean
  safeName: (n: string) => string
  uniqueTarget: (dir: string, name: string, taken: (f: string) => boolean) => string
  install: (ses: unknown, deps: unknown) => boolean
}

describe('只接管公开文件', () => {
  it('http/https 才接管；blob: / data: / 非法一律放行', () => {
    expect(intake.isHttpUrl('https://a/b.zip')).toBe(true)
    expect(intake.isHttpUrl('http://a/b')).toBe(true)
    expect(intake.isHttpUrl('blob:https://a/x')).toBe(false)
    expect(intake.isHttpUrl('data:text/plain,x')).toBe(false)
    expect(intake.isHttpUrl('随便写的')).toBe(false)
  })

  it('文件名清洗：去路径、去非法字符、空名兜底 download', () => {
    expect(intake.safeName('a/b\\c:d*e?.zip')).toBe('c_d_e_.zip')
    expect(intake.safeName('')).toBe('download')
    expect(intake.safeName('..')).toBe('download')
  })

  it('同名让位：a.zip → a(1).zip → a(2).zip', () => {
    const taken = (f: string) => f.endsWith('a.zip') || f.endsWith('a(1).zip')
    expect(intake.uniqueTarget('E:\\d', 'a.zip', taken)).toBe(join('E:\\d', 'a(2).zip'))
  })
})

/** 造一个假 session + 假 item，真跑一遍 will-download */
function harness() {
  let handler: ((event: unknown, item: unknown) => void) | null = null
  const added: Record<string, unknown>[] = []
  const prevented: number[] = []
  let saved = ''
  const ok = intake.install(
    {
      on: (name: string, fn: (event: unknown, item: unknown) => void) => {
        if (name === 'will-download') handler = fn
      },
    },
    {
      dir: () => 'E:\\dl',
      isTaken: () => false,
      add: (input: object) => {
        added.push(input as Record<string, unknown>)
        return { ok: true }
      },
    },
  )
  const fire = (url: string, name: string) =>
    handler!(
      { preventDefault: () => prevented.push(1) },
      {
        getURL: () => url,
        getFilename: () => name,
        setSavePath: (p: string) => {
          saved = p
        },
      },
    )
  return { ok, added, prevented, fire, saved: () => saved }
}

describe('will-download：公开文件进队列，其余放行', () => {
  it('公开文件被拦下（preventDefault）+ 转成 origin=browser 的任务', () => {
    const t = harness()
    expect(t.ok).toBe(true)
    t.fire('https://a/b.zip', 'b.zip')
    expect(t.prevented).toHaveLength(1)
    expect(t.added).toHaveLength(1)
    expect(t.added[0].origin).toBe('browser')
    expect(t.added[0].url).toBe('https://a/b.zip')
  })

  it('blob: 不拦（没调 preventDefault），只设保存路径', () => {
    const t = harness()
    t.fire('blob:https://a/x', 'x.bin')
    expect(t.prevented).toHaveLength(0)
    expect(t.added).toHaveLength(0)
    expect(t.saved().endsWith('x.bin')).toBe(true)
  })

  it('拿到的不是 session → install 返回 false（不崩）', () => {
    expect(
      intake.install(null, { dir: () => '', isTaken: () => false, add: () => ({ ok: true }) }),
    ).toBe(false)
  })
})

describe('接线 + 台账字段', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

  it('★ browser.cjs 在网页分区 session 上挂了 will-download（intake.install）', () => {
    const src = read('electron/handlers/browser.cjs')
    expect(src).toContain('download-intake.cjs')
    expect(src).toContain('downloadIntake.install(')
    expect(src).toContain('webviewPermissions.PARTITION')
  })

  it('★ 台账 add 记录 origin；旧记录读出来兜底 user', () => {
    const store = require_(join(ROOT, 'electron/core/download-store.cjs')) as {
      setFilePathForTest: (p: string) => void
      add: (i: object) => { ok: boolean; item?: { origin?: string } }
      list: () => { origin?: string }[]
    }
    const ledger = join(SANDBOX, 'ledger.json')
    store.setFilePathForTest(ledger)
    /* 先写一条「旧记录」（没有 origin），再让 store 读回来 */
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        limits: { maxConcurrent: 2, maxKBps: 0, connections: 4 },
        items: [{ id: 'dl_old', url: 'https://a/old.bin', file: 'E:\\d\\old.bin', status: 'done' }],
      }),
      'utf8',
    )
    expect(store.list()[0]?.origin).toBe('user')

    const u = store.add({ url: 'https://a/u.bin', file: 'E:\\d\\u.bin' })
    const b = store.add({ url: 'https://a/b.bin', file: 'E:\\d\\b.bin', origin: 'browser' })
    expect(u.item?.origin).toBe('user')
    expect(b.item?.origin).toBe('browser')
    store.setFilePathForTest('')
  })
})
