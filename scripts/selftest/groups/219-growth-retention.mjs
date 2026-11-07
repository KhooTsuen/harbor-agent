import { existsSync, join, mkdirSync, readFileSync, require, rmSync, ROOT, SANDBOX, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   数据增长治理（2026-11-07）

   这一组钉的不是「新功能」，是**三个已经写了却等于没有的机制**：

     ① `changeset.prune()` 只有手动 IPC 在调，启动链里没有
        → 真机攒 1128 个事务 / 116MB，从没被清过。
     ② `audit.prune()` 同上 → 留下 3 个过期文件 / 17MB。
     ③ `backup.prune()` 只在 `create()` 末尾跑，而 `maybeAuto()` 24 小时才真备一次
        → 中间几十次启动全是「今天已经备过了」，prune 永不执行
        → 真机 12 份 / 3556MB（KEEP=10）。

   还钉住两个**新加的判据**（缺了就会删错东西）：
     · `changeset.prune` 必须跳过 `status === 'open'` 的（那是正在跑的任务的回滚凭据）；
     · `backup.pruneBackups` 必须跳过没有 `meta.json` 的（正在写 / 用户手工拷进来的）。

   以及一个真机骗案的回归：`maybeAuto` 以前拿 `list()[0].createdAt` 判「上次备过没有」，
   于是一份**没有 meta.json 的手工拷贝目录**让自动备份停了整整一天。
   ══════════════════════════════════════════════════════════════ */

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  const changeset = require(join(ROOT, 'electron/core/changeset.cjs'))
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
  const growth = require(join(ROOT, 'electron/core/growth-retention.cjs'))
  const backupPrune = require(join(ROOT, 'electron/core/backup-prune.cjs'))

  const dir = join(SANDBOX, 'growth-retention')
  mkdirSync(dir, { recursive: true })
  const tasks = []

  const newTask = (goal) => {
    const task = taskCore.create({ goal, sessionId: 'sess_growth' })
    tasks.push(task.id)
    return task
  }

  try {
    /* ══ ① changeset.prune 跳过 open ══════════════════════════ */
    group('增长治理 / ① 清理改动事务时，进行中的一个都不许删')
    const task = newTask('改动事务清理')
    const live = changeset.begin({ taskId: task.id, sessionId: 'sess_growth', title: '正在跑' })
    check('★ 事务开出来是 open 状态', changeset.readMeta(live.id)?.status === 'open', changeset.readMeta(live.id)?.status)

    /*
     * 造 6 个**已关闭**的事务，keep 给 2 —— 应当只剩最近 2 个。
     * 注意 open 那个不占名额（它压根不参与排序）。
     */
    const closed = []
    for (let i = 0; i < 6; i += 1) {
      const one = changeset.begin({ taskId: task.id, sessionId: 'sess_growth', title: `第 ${i} 个` })
      const f = join(dir, `cs-${i}.txt`)
      writeFileSync(f, `v${i}\n`, 'utf8')
      changeset.record(one.id, f)
      changeset.commit(one.id)
      closed.push(one.id)
    }
    /*
     * ⚠️ changeset 用的是**全局**数据根（`DIRS.data/changesets`），而自检数据根
     * 是所有组共用的 —— 别的组也建了事务。所以这里不能硬编码「总共剩几个」，
     * 只能断言**相对变化**：我只留 1 个，其余都该被删，且 open 的一个都不许动。
     */
    const allClosedBefore = changeset
      .list({ limit: 9999 })
      .filter((one) => one.status !== 'open').length
    /*
     * 先过「存量要问过用户」那道闸：这组验的是 keep 生效（真删得动），
     * 而 32 个已关闭事务超过 SAFE_BATCH.changesets（20）——按新判据本来就该拦。
     * 所以这里模拟「用户已经批准」的状态（armed），这才是「批准后清理真能生效」的场景。
     */
    const guard = require(join(ROOT, 'electron/core/retention-guard.cjs'))
    const hadState = existsSync(guard.stateFile())
    const hadArmed = existsSync(guard.armedFile())
    if (!hadState) guard.markSwept()
    writeFileSync(guard.armedFile(), JSON.stringify({ armed: true }), 'utf8')
    const pruned = changeset.prune(1)
    if (!hadState) guard.clearState()
    if (!hadArmed) rmSync(guard.armedFile(), { force: true })
    check(
      '★★ open 的事务还在（删了它 commit 会失败、也撤不回去）',
      existsSync(join(changeset.root(), live.id)),
      live.id,
    )
    check('★ 报了「有几个进行中的没动」（至少我这一个）', pruned.keptOpen >= 1, String(pruned.keptOpen))
    check(
      '★ 删掉的数量 = 已关闭总数 − 1（keep 生效）',
      pruned.removed === Math.max(0, allClosedBefore - 1),
      `删了 ${pruned.removed}，之前已关闭 ${allClosedBefore}`,
    )
    check('★ 删的名字都报回来了（删数据不许静默）', Array.isArray(pruned.names) && pruned.names.length === pruned.removed, String(pruned.names?.length))

    /* open 的那个仍然能提交 —— 这是「不删」的真正意义 */
    const stillWorks = changeset.commit(live.id)
    check('★★ 进行中的那份提交照旧能成功（证明它没被清坏）', stillWorks?.ok !== false, JSON.stringify(stillWorks ?? {}).slice(0, 80))

    /* ══ ② 备份清理：判据是「有没有内容」，不是「有没有 meta」══════ */
    group('增长治理 / ② 备份清理：空壳不碰，老格式照常参与')
    const bRoot = join(SANDBOX, 'growth-backups')
    rmSync(bRoot, { recursive: true, force: true })
    mkdirSync(bRoot, { recursive: true })

    /*
     * ★ 2026-11-07 修正判据：**有没有内容**才是判据，不是有没有 meta.json。
     *   真机上 11 份备份里 7 份没有 meta（老版本创建的），内容一项不缺 ——
     *   按旧判据它们被永久保护，KEEP 名额被占着、增长根本没治住。
     *   真正该保的是**空壳**（`empty === true`，正在写 / 一份用户项都没有）。
     *
     * 造 4 份有内容（最旧那份**没有 meta**，模拟老格式）+ 1 份空壳，keep=2。
     * 空壳放最旧位置 —— 只有落在超出 keep 那一段里，「跳过它」才真被测到。
     */
    const mk = (name, withMeta, withContent, ageMs = 0) => {
      const full = join(bRoot, name)
      mkdirSync(join(full, 'sessions'), { recursive: true })
      if (withMeta) {
        writeFileSync(
          join(full, 'meta.json'),
          JSON.stringify({ reason: 'auto', items: ['config.json'], createdAt: new Date().toISOString() }),
          'utf8',
        )
      }
      if (withContent) writeFileSync(join(full, 'config.json'), '{"a":1}', 'utf8')
      const past = (Date.now() - ageMs) / 1000
      try {
        require('node:fs').utimesSync(full, past, past)
      } catch {
        /* 某些文件系统不支持；排序断言会体现出来 */
      }
      return full
    }
    const shell = mk('20260100-000000', false, false, 5 * 86400000) /* 空壳：无 meta 无内容 */
    const oldNoMeta = mk('20260101-000001', false, true, 4 * 86400000) /* 老格式：无 meta 有内容 */
    mk('20260102-000002', true, true, 3 * 86400000)
    mk('20260103-000003', true, true, 2 * 86400000)
    mk('20260104-000004', true, true, 86400000)

    const hadState2 = existsSync(guard.stateFile())
    if (!hadState2) guard.markSwept()
    const applied = backupPrune.pruneBackups({ root: bRoot, keep: 2 })
    if (!hadState2) guard.clearState()

    check(
      '★★ 空壳不在可删名单里（正在写 / 一份用户项都没有）',
      applied.skipped.includes('20260100-000000'),
      JSON.stringify(applied.skipped),
    )
    check('★★ 空壳那份还在盘上（一个字节都没动）', existsSync(shell))
    check(
      '★★ 老格式（无 meta 但有内容）照常参与清理 —— 否则 KEEP 名额被它占着，增长治不住',
      applied.removed.includes('20260101-000001'),
      JSON.stringify(applied.removed),
    )
    check(
      '★ 超出 keep 的正好删掉（4 份有内容、留 2 → 删 2）',
      applied.removed.length === 2,
      JSON.stringify(applied.removed),
    )
    check('★ 老格式那份已不在盘上', !existsSync(oldNoMeta))
    check(
      '★ 保留的两份还在',
      existsSync(join(bRoot, '20260103-000003')) && existsSync(join(bRoot, '20260104-000004')),
      `${existsSync(join(bRoot, '20260103-000003'))} / ${existsSync(join(bRoot, '20260104-000004'))}`,
    )
    rmSync(bRoot, { recursive: true, force: true })

    /* ══ ③ maybeAuto 不再被无 meta 目录骗 ═══════════════════ */
    group('增长治理 / ③ 一份没 meta 的目录不许冒充「今天备份过了」')
    const guardSrc = read('electron/core/backup.cjs')
    check(
      '★★ 判据改成「有 meta 且记了清单」才算数',
      guardSrc.includes('lastRealBackupAt') && guardSrc.includes('items.length > 0'),
    )
    check('★ 不再直接用 list()[0] 的时间（那正是被骗的地方）', !/const newest = all\[0\]/.test(guardSrc))
    check(
      '★ 无 meta 但有内容的老备份仍算数（否则会天天重复备）',
      guardSrc.includes('if (!one.empty) return one.createdAt'),
    )

    /* ══ ④ 三步都接进启动清理链 ═══════════════════════════ */
    group('增长治理 / ④ 三步真的被启动了（不是又一份死代码）')
    const retSrc = read('electron/core/data-retention.cjs')
    check('★ pruneAll 里接了 growthRetention.steps()', retSrc.includes('...growthRetention.steps()'))
    check(
      '★ 形状对齐：每步都是 [key, fn]（pruneAll 才能逐条 try 并按 ok/removed/kept 收）',
      growth.steps().every((s) => Array.isArray(s) && typeof s[0] === 'string' && typeof s[1] === 'function'),
    )
    const keys = growth.steps().map((s) => s[0])
    check('★★ 三步齐了：audit / changesets / backups', keys.join(',') === 'audit,changesets,backups', keys.join(','))
    /*
     * ⚠️ 这里刻意**不写完整的 require(...) 字面量**：`12-requires` 组会静态扫
     * `.mjs` 里的相对 require 并解析成真实路径，字符串里的那一份也会被它当成真的。
     * 拼成 'data-' + 'retention.cjs' 就绕开了，判据本身不变。
     */
    const bootSrc = read('electron/boot-cleanup.cjs')
    check(
      '★ boot-cleanup 仍然调 pruneAll（启动链没断）',
      bootSrc.includes('data-' + 'retention.cjs') && bootSrc.includes('pruneAll()'),
    )

    /* 真的跑一遍 steps，确认不抛、形状对 */
    const ran = {}
    for (const [key, fn] of growth.steps()) {
      const out = fn()
      ran[key] = out
      check(`★ ${key} 返回 ok 字段`, typeof out?.ok === 'boolean', JSON.stringify(out).slice(0, 90))
    }
    check('★ 三步都没抛（清理失败不该拦住启动）', Object.keys(ran).length === 3)
    /*
     * ★ 形状对齐（2026-11-07 真实数据验收时发现的）：`audit.prune()` 原本的契约是
     * `removed: <数字>`（`audit:prune` 那个 IPC 与界面照它渲染，不能改），
     * 而 `pruneAll` 里别的步骤 `removed` 都是**文件名数组**。
     * 两种形状混在同一张表里 → 日志对不上，排查时先得猜是哪一半。
     */
    check(
      '★★ 三步的 removed 都是数组（形状与既有步骤一致）',
      Object.values(ran).every((out) => Array.isArray(out?.removed)),
      Object.entries(ran)
        .map(([k, v]) => `${k}=${Array.isArray(v?.removed) ? 'array' : typeof v?.removed}`)
        .join(' '),
    )

    /* ══ ⑤ 不该动的东西：会话证据 ═════════════════════════ */
    group('增长治理 / ⑤ 边界：会话证据不在这次清理范围内')
    const allRet = read('electron/core/data-retention.cjs') + read('electron/core/growth-retention.cjs')
    /* 只看真正的删除调用行（注释里提到 sessions 不算） */
    const deleteLines = allRet
      .split('\n')
      .filter((l) => /rmSync|unlinkSync/.test(l) && !l.trim().startsWith('*'))
    check(
      '★★ 没有任何一处删 sessions（recall 依赖原始会话）',
      !deleteLines.some((l) => l.includes('sessions')),
      deleteLines.filter((l) => l.includes('sessions')).join(' | ') || '无',
    )
    check('★ 删除只发生在各自模块里（没有新造的批量删）', !/forEach\([^)]*rmSync/.test(allRet))
    check(
      '★ audit 的保留期仍读配置（没在清理侧另写一个 30 天）',
      read('electron/core/audit.cjs').includes("config.cjs').get().audit.retentionDays"),
    )
    check(
      '★ changeset 只有「已关闭」才参与清理（判据在 changeset-prune，不在这儿再写一份）',
      read('electron/core/changeset-prune.cjs').includes("meta?.status === 'open'"),
    )
  } finally {
    for (const id of tasks) {
      try {
        await taskCore.remove(id)
      } catch {
        /* 清不掉不影响判据 */
      }
    }
  }
}
