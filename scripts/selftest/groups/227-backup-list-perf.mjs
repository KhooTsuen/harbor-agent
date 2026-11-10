import { check, group } from '../harness.mjs'
import { join, mkdirSync, require, rmSync, ROOT, SANDBOX, writeFileSync } from '../env.mjs'
import { statSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   227 —— 备份列表不许卡住主进程（2026-11-08 真机卡顿的回归）

   ── 病 ────────────────────────────────────────────────────────
   设置页「数据与用量」一打开就卡几秒。查下来**不是**统计接口：

     `BackupPanel` 挂载即拉 `backup:list` → `backup-scan.list()` 对每份备份
     递归 `statSync` 算体积。Dev 现场 12 份 / 22615 个文件 = **6.2~7.0 秒**，
     而且**同步**跑在主进程 → 界面完全点不动。

   同一条路还在启动链上：`maybeAuto()`（判今天备过没）与
   `pruneBackups()`（清理超量）都要 `list()` —— 每次启动白卡六七秒，只为判个时间。

   ── 修 ────────────────────────────────────────────────────────
   ① 体积带缓存（`.sizes.json` + 进程内 Map，键 = 目录 mtime）；
   ② IPC 走 `listAsync`，冷路径**不等扫盘**，给 `null` 并丢给后台补算；
   ③ 启动链 / 清理链走 `{ sizes: 'cache' }` —— 它们根本不需要体积；
   ④ 新备份在 `create()` 里把体积写进 `meta.totalBytes`，之后 0 成本。

   ⚠️ 全部在 SANDBOX 造合成数据，不碰真实备份目录。
   ══════════════════════════════════════════════════════════════ */

/** 造一份假备份：`files` 个文件、每个 `bytes` 字节 */
function makeBackup(root, name, files, bytes) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeFileSync(join(dir, 'config.json'), '{"a":1}', 'utf8')
  for (let i = 0; i < files; i += 1) {
    writeFileSync(join(dir, 'sessions', `s${i}.jsonl`), 'x'.repeat(bytes), 'utf8')
  }
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ reason: 'auto', items: ['config.json', 'sessions'], createdAt: new Date().toISOString(), version: 1 }),
    'utf8',
  )
  return dir
}

/** 独立算一遍目录体积（不用产品代码），用作期望值 —— 避免我手算错 */
function walkSize(dir) {
  let total = 0
  const walk = (p) => {
    for (const entry of require('node:fs').readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  walk(dir)
  return total
}

export async function run() {
  const sizeCore = require(join(ROOT, 'electron/core/backup-size.cjs'))
  const scan = require(join(ROOT, 'electron/core/backup-scan.cjs'))

  const root = join(SANDBOX, 'g227-backups')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  try {
    /* ══ ① 体积缓存：算一次，第二次不扫盘 ══════════════════════ */
    group('备份卡顿 / ① 体积缓存（目录没变就不再扫盘）')
    const r1 = join(SANDBOX, 'g227-r1')
    rmSync(r1, { recursive: true, force: true })
    mkdirSync(r1, { recursive: true })
    const one = makeBackup(r1, '20260101-000001', 40, 100)
    const expect1 = walkSize(one)
    const s1 = sizeCore.dirSizeCached(one, { allowCompute: true })
    check('★ 第一次算出的体积 = 目录里所有文件之和', s1 === expect1, `${s1} vs 期望 ${expect1}`)
    const s2 = sizeCore.dirSizeCached(one, { allowCompute: false })
    check('★★ 第二次走缓存（allowCompute:false 也能拿到）', s2 === s1, `${s2} vs ${s1}`)

    /* 直接往这一层加文件（目录 mtime 会变）→ 必须重算 */
    writeFileSync(join(one, 'extra.jsonl'), 'y'.repeat(50), 'utf8')
    const expect2 = walkSize(one)
    const s3 = sizeCore.dirSizeCached(one, { allowCompute: true })
    check(
      '★★★ 这一层变了就重算（不给过期体积）',
      s3 === expect2 && s3 === s1 + 50,
      `${s3} vs 期望 ${expect2}（原 ${s1} + 50）`,
    )

    /* 往**子目录**加文件：父目录 mtime 不变 → 缓存会给出旧值，靠 TTL 兜底 */
    writeFileSync(join(one, 'sessions', 'deep.jsonl'), 'z'.repeat(30), 'utf8')
    const afterDeep = sizeCore.dirSizeCached(one, { allowCompute: false })
    check(
      '★★ 子目录变化 mtime 看不出来 → 缓存仍给旧值（这是已知局限，TTL 兜底）',
      afterDeep === s3,
      `${afterDeep} vs ${s3}`,
    )

    /* 不存在的目录 → null，不是 0 */
    const ghost = sizeCore.dirSizeCached(join(r1, 'nope'), { allowCompute: true })
    check('★★ 目录不存在 → null（不是 0，0 是「确认为空」）', ghost === null, String(ghost))

    /* ══ ② listAsync 冷路径不等扫盘 ════════════════════════════ */
    group('备份卡顿 / ② 冷路径立刻返回（体积先给 null）')
    /* 用全新 root：内存里没有它任何一条记录，才是真正的「冷」 */
    const r2 = join(SANDBOX, 'g227-r2')
    rmSync(r2, { recursive: true, force: true })
    mkdirSync(r2, { recursive: true })
    for (let i = 1; i <= 5; i += 1) {
      makeBackup(r2, `2026010${i}-00000${i}`, 30, 80)
    }

    const t0 = process.hrtime.bigint()
    const list = await scan.listAsync(r2)
    const coldMs = Number(process.hrtime.bigint() - t0) / 1e6

    check('★ 5 份都列出来了', list.length === 5, String(list.length))
    check('★★ 冷路径不扫盘（100ms 以内 —— 真机 12 份/2 万文件全扫要 6~7 秒）', coldMs < 100, `${coldMs.toFixed(1)} ms`)
    check(
      '★★ 没缓存时 size 是 null（不知道），不是 0',
      list.every((b) => b.size === null),
      list.map((b) => String(b.size)).join(','),
    )

    /* ══ ③ 后台补算会把体积补上 ═══════════════════════════════ */
    group('备份卡顿 / ③ 后台补算（算完写缓存，下次就有）')
    /* 等后台把这 5 份补完（每份 30 个文件，很快） */
    let warmed = []
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      warmed = await scan.listAsync(r2)
      if (warmed.every((b) => b.size !== null)) break
    }
    check('★★★ 后台补算后体积都有值了', warmed.every((b) => b.size !== null), warmed.map((b) => String(b.size)).join(','))
    check(
      '★ 补出来的数字与磁盘上实际大小一致',
      warmed.every((b) => b.size === walkSize(join(r2, b.name))),
      warmed.map((b) => `${b.name}:${b.size}`).join(','),
    )
    check('★ 缓存文件写出来了', (() => {
      try {
        return statSync(join(r2, '.sizes.json')).size > 0
      } catch {
        return false
      }
    })())

    /* 再列一次：这次全走缓存 */
    const t1 = process.hrtime.bigint()
    const again = await scan.listAsync(r2)
    const warmMs = Number(process.hrtime.bigint() - t1) / 1e6
    check('★★ 热路径也很快（100ms 以内）', warmMs < 100, `${warmMs.toFixed(1)} ms`)
    check('★ 热路径数字与补算的一致', again.every((b, i) => b.size === warmed[i].size), '')

    /* ══ ④ 启动链 / 清理链：只查缓存，不扫盘 ═══════════════════ */
    group('备份卡顿 / ④ 启动链与清理链不扫盘（它们不需要体积）')
    /*
     * 用一个**全新目录**测「冷缓存」—— 内存里没有它的任何记录。
     * 上一个 root 里内存 Map 已经热了，拿它测不出冷路径。
     */
    const coldRoot = join(SANDBOX, 'g227-cold')
    rmSync(coldRoot, { recursive: true, force: true })
    mkdirSync(coldRoot, { recursive: true })
    for (let i = 1; i <= 3; i += 1) makeBackup(coldRoot, `2026020${i}-00000${i}`, 20, 60)

    const t2 = process.hrtime.bigint()
    const cacheOnly = scan.list(coldRoot, { sizes: 'cache' })
    const cacheMs = Number(process.hrtime.bigint() - t2) / 1e6
    check('★★ 冷缓存下也立刻返回（50ms 以内）', cacheMs < 50, `${cacheMs.toFixed(1)} ms`)
    check(
      '★ 名字 / 顺序 / empty 判据都还在（只是体积未知）',
      cacheOnly.length === 3 &&
        cacheOnly.every((b) => typeof b.name === 'string' && typeof b.empty === 'boolean') &&
        cacheOnly.every((b) => b.size === null),
      JSON.stringify(cacheOnly.map((b) => ({ n: b.name, s: b.size, e: b.empty }))),
    )
    rmSync(coldRoot, { recursive: true, force: true })

    /* ══ ⑤ meta 里记了体积 → 0 成本（新备份走这条） ═══════════ */
    group('备份卡顿 / ⑤ 新备份把体积写进 meta（之后不必扫）')
    const r5 = join(SANDBOX, 'g227-r5')
    rmSync(r5, { recursive: true, force: true })
    mkdirSync(r5, { recursive: true })
    const withMeta = makeBackup(r5, '20260109-000009', 5, 10)
    const meta = JSON.parse(require('node:fs').readFileSync(join(withMeta, 'meta.json'), 'utf8'))
    /* 手工塞一个（模拟 create() 写过） */
    meta.totalBytes = 12345
    writeFileSync(join(withMeta, 'meta.json'), JSON.stringify(meta), 'utf8')
    const fromMeta = await scan.listAsync(r5)
    const target = fromMeta.find((b) => b.name === '20260109-000009')
    check('★★ meta 里有体积就直接用（一行都不扫）', target?.size === 12345, String(target?.size))

    /* ══ ⑥ 卡顿回归哨兵：源码层 ══════════════════════════════ */
    group('备份卡顿 / ⑥ 源码层哨兵（防有人把同步扫盘改回来）')
    const fsRead = require('node:fs').readFileSync
    const scanSrc = fsRead(join(ROOT, 'electron/core/backup-scan.cjs'), 'utf8')
    const pruneSrc = fsRead(join(ROOT, 'electron/core/backup-prune.cjs'), 'utf8')
    const backupSrc = fsRead(join(ROOT, 'electron/core/backup.cjs'), 'utf8')
    const extrasSrc = fsRead(join(ROOT, 'electron/handlers/extras.cjs'), 'utf8')

    /* 只看代码行，注释里提到不算（被注释误伤过三次） */
    const codeOf = (src) =>
      src
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
        .join('\n')

    check(
      '★★★ IPC 的 backup:list 走 listAsync（不是同步 list）',
      /backup:list',\s*\(\)\s*=>\s*backup\.listAsync\(\)/.test(codeOf(extrasSrc)),
      '如果是 backup.list() 就会同步卡 6~7 秒',
    )
    check(
      '★★ 启动判重（lastRealBackupAt）只要缓存，不扫体积',
      /list\(backupRoot\(\), \{ sizes: 'cache' \}\)/.test(codeOf(backupSrc)),
    )
    check(
      '★★ 清理（prune / planPrune）也不扫体积',
      /sizes: 'cache'/.test(codeOf(pruneSrc)) && /sizes: 'cache'/.test(codeOf(backupSrc)),
    )
    check(
      '★ 异步版 listAsync 还在导出里',
      /listAsync/.test(codeOf(scanSrc)) && Boolean(scan.listAsync),
    )
    check(
      '★★ create() 把体积写进 meta.totalBytes（新备份 0 成本）',
      /totalBytes: createdBytes/.test(codeOf(backupSrc)),
    )

    /* ══ ⑦ 第 13 项：恢复中途被强杀要认得出 ═══════════════════ */
    group('恢复标记 / ⑦ 未完成的恢复（第 13 项）')
    const mark = require(join(ROOT, 'electron/core/backup-restore-mark.cjs'))
    const bootSrc = fsRead(join(ROOT, 'electron/boot-cleanup.cjs'), 'utf8')

    check('★★★ 没有恢复在进行时 pending() 是 null', mark.pending() === null)
    mark.begin('20260101-000000', '20260101-000001')
    const live = mark.pending()
    check(
      '★★★ begin 之后认得出是哪份备份、回退快照是谁',
      live?.name === '20260101-000000' && live?.safety === '20260101-000001',
      JSON.stringify(live),
    )
    mark.touch('sessions')
    mark.touch('tasks')
    check(
      '★★ 进度会累加（重启后能说「盖到第几项」）',
      mark.pending()?.touched.join(',') === 'sessions,tasks',
      JSON.stringify(mark.pending()?.touched),
    )
    mark.finish()
    check('★★ 收尾后标记消失（正常恢复不该被误报成中断）', mark.pending() === null)

    check(
      '★★★ restore() 里留标记 / 记进度 / 收尾三处都接上了',
      /restoreMark\.begin\(/.test(codeOf(backupSrc)) &&
        /restoreMark\.touch\(/.test(codeOf(backupSrc)) &&
        /restoreMark\.finish\(/.test(codeOf(backupSrc)),
    )
    check(
      '★★★ 留不下标记就中止（没有它就无法识别中断，等于再造一个中间态坑）',
      /restoreMark\.begin\([\s\S]{0,400}?aborted: true/.test(codeOf(backupSrc)),
    )
    check(
      '★★ 启动时检查未完成的恢复（不然标记写了没人读 = 没有闸门）',
      /backup-restore-mark\.cjs'\)\.pending\(\)/.test(codeOf(bootSrc)),
    )
  } finally {
    /* 标记是我的用例起的，无论成败都清掉，不留给下一个组 */
    require(join(ROOT, 'electron/core/backup-restore-mark.cjs')).finish()
    for (const dir of ['g227-r1', 'g227-r2', 'g227-cold', 'g227-r5']) {
      rmSync(join(SANDBOX, dir), { recursive: true, force: true })
    }
    rmSync(root, { recursive: true, force: true })
  }
}
