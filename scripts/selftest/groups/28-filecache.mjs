import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-019：避免重复读取

   文档要求缓存至少记录：createdAt / updatedAt / ttl / source / validity /
   fileModifiedTime，并且**文件发生变化时自动失效**。

   ★ 这一条最危险的失败方式是「**写完之后还读到旧内容**」——
     比「没缓存」严重得多（Agent 会基于一个已经不存在的版本继续改）。
     所以 mtime 判据之外，写操作还要显式 invalidate 一次：
     Windows 上文件 last-write-time 的精度不保证到毫秒（AG-016 踩过），
     「刚写完立刻读」有极小概率 stat 出同一个值。
   ══════════════════════════════════════════════════════════════ */

const cache = require(join(ROOT, 'electron/core/file-cache.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const dir = join(ROOT, 'data', 'selftest-workspace')
const file = join(dir, 'cache-target.txt')

export async function run() {
  group('AG-019 · 文件读取缓存')

  cache.clear()

  /* ── 基本命中 ── */
  writeFileSync(file, '第一版内容')
  check('没存过时不命中', cache.get(file).hit === false)
  check('没命中会说原因', cache.get(file).reason === 'miss')

  cache.put(file, { content: '第一版内容', source: 'read_file' })
  const first = cache.get(file)
  check('存过之后命中', first.hit === true)
  check('拿到的是存进去的内容', first.content === '第一版内容')

  /* ── ★ 文件改了 → 自动失效 ── */
  const later = new Date(Date.now() + 60_000)
  utimesSync(file, later, later)
  const afterChange = cache.get(file)
  check('★ 文件 mtime 变了 → 不再命中', afterChange.hit === false)
  check('★ 而且说清是「内容变了」而不是「没存过」', afterChange.reason === 'changed')

  /* ── TTL 过期 ── */
  cache.clear()
  cache.put(file, { content: '会过期的', source: 'read_file', ttl: 1 })
  await new Promise((r) => setTimeout(r, 30))
  const expired = cache.get(file)
  check('★ 超过 ttl 之后不命中', expired.hit === false)
  check('原因是 expired', expired.reason === 'expired')

  /* ── 文件没了 ── */
  cache.clear()
  writeFileSync(file, 'x')
  cache.put(file, { content: 'x', source: 'read_file' })
  rmSync(file, { force: true })
  const gone = cache.get(file)
  check('★ 文件被删 → 不命中', gone.hit === false)
  check('原因是 gone', gone.reason === 'gone')

  /* ── 显式作废（写操作走这条） ── */
  writeFileSync(file, 'again')
  cache.put(file, { content: 'again', source: 'read_file' })
  check('先确认它在', cache.get(file).hit === true)
  cache.invalidate(file)
  check('★ invalidate 之后立刻不命中（不等 mtime 判据）', cache.get(file).hit === false)

  /* ── entry 上的字段齐不齐（文档点名的六个） ── */
  writeFileSync(file, 'fields')
  const entry = cache.put(file, { content: 'fields', source: 'read_file' })
  for (const key of ['createdAt', 'updatedAt', 'ttl', 'source', 'fileModifiedTime', 'content']) {
    check(`entry 上有 ${key}`, entry[key] !== undefined)
  }
  check(
    'validity 是命中时算出来的（get 返回 hit 就是有效）',
    typeof cache.get(file).hit === 'boolean',
  )
  check('source 记下了是谁读的', entry.source === 'read_file')

  /* ── 统计 ── */
  cache.clear()
  writeFileSync(file, 'stats')
  cache.put(file, { content: 'stats', source: 'read_file' })
  cache.get(file)
  cache.get(file)
  const s = cache.stats()
  check('hits 数得对', s.hits === 2)
  check('有上限（防长会话无限涨）', s.max > 0 && s.max <= 1000)

  /* ── 接进工具了没 ── */
  const readSrc = readCore('electron/core/tools/read_file.cjs')
  check('★ read_file 会用缓存', readSrc.includes('fileCache.get(file)'))
  check('★ 命中时会标注「与上次读取内容一致」', readSrc.includes('与上次读取内容一致'))
  check(
    '★ 命中时照样把内容给出去（历史可能被压缩，不能只说「没变」）',
    readSrc.includes('cached.hit ? cached.content : readTextFile(file)'),
  )
  check(
    '★ 没命中才写缓存（不对空结果建缓存）',
    readSrc.includes('if (!cached.hit) fileCache.put(file'),
  )

  const writeSrc = readCore('electron/core/tools/write_file.cjs')
  const editSrc = readCore('electron/core/tools/edit_file.cjs')
  check('★ write_file 写完作废缓存', writeSrc.includes('fileCache.invalidate(file)'))
  check('★ edit_file 改完作废缓存', editSrc.includes('fileCache.invalidate(file)'))

  cache.clear()
  rmSync(file, { force: true })
}
