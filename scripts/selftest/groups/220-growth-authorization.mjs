import { join, mkdirSync, readFileSync, require, rmSync, ROOT, SANDBOX, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   存量清理的授权门槛 + 备份可恢复（2026-11-07）

   ── 两组病，都是「机制写了却不可靠」──

   ① **存量清理没过用户**：上一轮把三处清理接进启动链，代价是下次启动会一口气
      删掉 1078 个改动事务 + 345MB 备份 + 17MB 审计日志 —— 全是用户第一次见到
      这套策略之前就攒下的，他没批过。
   ② **备份没验过真能恢复**：只验过「文件拷进去了」，没验过「拷回来一模一样」。

   ── 这一组钉什么 ──

   授权门槛（`retention-guard.cjs`）：
     · 首次清扫 → 一律只盘点，一个字节都不删（哪怕只超量 1 份）
     · 批准后（放 armed 文件）→ 真删，且只删候选
     · 日常增量（非首次 + 量小）→ 直接删，不需要批准（否则清理永远不生效）
     · `open` 的改动事务**批准了也不删**
     · 空壳备份不删（留着让人看见它坏了）
     · 清单如实写（数量 + 体积），且不含 sessions

   备份恢复（`backup.create` → `backup.restore`，走生产接口）：
     · 内容逐字节一致（不是「看起来回来了」）
     · 空壳备份拒绝恢复（否则拿空目录盖掉用户数据）
     · 恢复先做 safety 快照（恢复本身可回退）
     · 非法名字被白名单挡住

   ⚠️ 判据里的路径全部落在 SANDBOX 下，不碰真实 data。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  /* ★ 必须最先 require guard：它的路径由 paths.cjs 定，自检已隔离到 selftest-data */
  const guard = require(join(ROOT, 'electron/core/retention-guard.cjs'))
  const dataDir = require(join(ROOT, 'electron/core/paths.cjs')).dataDir()

  /* ── 兜底：确认真的在隔离目录（不在就整组跳过，绝不拿真数据试删除） ── */
  group('增长治理 · 前置：确认在隔离目录')
  check(
    '★★ 当前数据根是隔离目录（否则下面的删除断言会砸到真数据）',
    /selftest-data|unit-test-data/.test(dataDir),
    dataDir,
  )

  /* 每个用例自己造状态，跑完恢复原状 */
  const snapshot = () => ({
    armed: guard.isArmed(),
    first: guard.isFirstSweep(),
    pending: guard.readPending(),
  })
  const original = snapshot()
  const resetState = () => {
    rmSync(guard.armedFile(), { force: true })
    rmSync(guard.stateFile(), { force: true })
    rmSync(guard.pendingFile(), { force: true })
  }

  try {
    /* ══ ① 首次清扫：一律只盘点 ══ */
    group('增长治理 / ① 首次清扫一个都不删（哪怕只超量 1 份）')
    resetState()
    check('★ 没有状态文件 = 首次', guard.isFirstSweep() === true)
    /*
     * 这条是核心：真机上备份只超量 **1 份**，按「数量阈值」会被判成日常量级直接删。
     * 首次清扫必须先拦住 —— 数量少不等于用户批过。
     */
    check('★★ 首次：超量 1 份也判 report（不删）', guard.decide({ key: 'backups', would: 1 }) === 'report')
    check('★★ 首次：超量 890 个判 report', guard.decide({ key: 'changesets', would: 890 }) === 'report')
    check('首次：0 个仍然给 apply（没东西可删不算拦）', guard.decide({ key: 'changesets', would: 0 }) === 'apply')

    /* ══ ② 批准之后真删 ══ */
    group('增长治理 / ② 批准之后才真删')
    writeFileSync(guard.armedFile(), JSON.stringify({ armed: true }), 'utf8')
    check('★ armed 文件被认出来', guard.isArmed() === true)
    check('★★ 批准后首次也放行（批了还拦等于批准没用）', guard.decide({ key: 'backups', would: 1 }) === 'apply')
    check('★★ 批准后大批量也放行', guard.decide({ key: 'changesets', would: 890 }) === 'apply')
    rmSync(guard.armedFile(), { force: true })

    /* ══ ③ 日常增量直接删（否则清理永远不生效） ══ */
    group('增长治理 / ③ 日常量级不需要批准（否则策略等于没有）')
    resetState()
    guard.markSwept()
    check('★ 记过一轮之后不再是首次', guard.isFirstSweep() === false)
    check(
      '★★ 日常量级（≤ 阈值）直接 apply',
      guard.decide({ key: 'changesets', would: guard.SAFE_BATCH.changesets }) === 'apply',
    )
    check(
      '★ 超阈值 → report（积压要问）',
      guard.decide({ key: 'changesets', would: guard.SAFE_BATCH.changesets + 1 }) === 'report',
    )
    check(
      '★ 超阈值 + 已批准 → apply',
      (() => {
        writeFileSync(guard.armedFile(), JSON.stringify({ armed: true }), 'utf8')
        const v = guard.decide({ key: 'changesets', would: 999 }) === 'apply'
        rmSync(guard.armedFile(), { force: true })
        return v
      })(),
    )

    /* ══ ④ 清单如实写，且不含 sessions ══ */
    group('增长治理 / ④ 待清理清单如实（人要能事先看到）')
    resetState()
    guard.notePending({ key: 'changesets', items: ['cs_a', 'cs_b'], bytes: 2048 })
    guard.notePending({ key: 'backups', items: ['20260101-000001'], bytes: 1024 })
    const pend = guard.readPending()
    check('★ changesets 写进了清单', pend.changesets?.count === 2, String(pend.changesets?.count))
    check('★ backups 写进了清单', pend.backups?.count === 1, String(pend.backups?.count))
    check('★ 记了体积（用户要知道能回收多少）', pend.changesets?.bytes === 2048)
    check('★★ sessions 不在清单里（它不在任何删除名单）', !('sessions' in pend))

    /* ══ ⑤ open 的改动事务：批准了也不删 ══ */
    group('增长治理 / ⑤ open 事务批准了也不删')
    resetState()
    guard.markSwept()
    writeFileSync(guard.armedFile(), JSON.stringify({ armed: true }), 'utf8')
    const changeset = require(join(ROOT, 'electron/core/changeset.cjs'))
    const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
    const task = taskCore.create({ goal: 'g219', sessionId: 'sess_g219000000001' })
    const live = changeset.begin({ taskId: task.id, sessionId: 'sess_g219000000001', title: 'live' })
    const csPrune = require(join(ROOT, 'electron/core/changeset-prune.cjs'))
    const plan = csPrune.planPrune(0) /* keep=0：连保留名额都没有，看它敢不敢删 open */
    check('★★ open 的事务不进删除候选', !plan.stale.includes(live.id), plan.stale.join(',') || '（空）')
    check('★ 它被单独计数（报给用户「N 个进行中没动」）', plan.keptOpen >= 1, String(plan.keptOpen))
    changeset.prune(0)
    const { existsSync } = require('node:fs')
    check('★★ 真删一轮之后 open 那份还在', existsSync(join(changeset.root(), live.id)))
    try {
      taskCore.remove(task.id)
    } catch {
      /* 清不掉不影响断言 */
    }
    rmSync(guard.armedFile(), { force: true })

    /* ══ ⑥ 空壳备份不删（留着让人看见） ══ */
    group('增长治理 / ⑥ 空壳备份不进删除候选')
    const backupPrune = require(join(ROOT, 'electron/core/backup-prune.cjs'))
    const scan = require(join(ROOT, 'electron/core/backup-scan.cjs'))
    const bkRoot = join(SANDBOX, 'g220-backups')
    rmSync(bkRoot, { recursive: true, force: true })
    mkdirSync(bkRoot, { recursive: true })
    /*
     * ★ 空壳必须放在**最旧**的位置（`ageMs` 最大）——只有落在 `slice(keep)` 之后，
     *   「跳过空壳」这条判据才真被测到。放最新的话它会被 keep 顺带保住，
     *   断言绿了但什么都没验到（219 组最早就是栽在这上面）。
     */
    const mkBackup = (name, withContent, ageMs) => {
      const full = join(bkRoot, name)
      mkdirSync(join(full, 'sessions'), { recursive: true })
      writeFileSync(join(full, 'meta.json'), JSON.stringify({ reason: 'auto', items: [] }), 'utf8')
      if (withContent) writeFileSync(join(full, 'config.json'), '{"a":1}', 'utf8')
      const past = (Date.now() - ageMs) / 1000
      try {
        require('node:fs').utimesSync(full, past, past)
      } catch {
        /* 排序断言会体现出来 */
      }
    }
    /* 空壳最旧（第 4 位），其余 3 份有内容 */
    mkBackup('20260101-000001', false, 4 * 86400000) /* 空壳，落在超量段里 */
    mkBackup('20260102-000002', true, 3 * 86400000)
    mkBackup('20260103-000003', true, 2 * 86400000)
    mkBackup('20260104-000004', true, 86400000)
    const bkPlan = backupPrune.planPrune({ root: bkRoot, keep: 2 })
    check(
      '★★ 空壳落在超量段里也不进候选（否则删掉就看不见「这份坏了」）',
      !bkPlan.candidates.some((b) => b.name === '20260101-000001'),
      `候选=${bkPlan.candidates.map((b) => b.name).join(',') || '（空）'} 跳过=${bkPlan.skipped.map((b) => b.name).join(',') || '（空）'}`,
    )
    check(
      '★ 有内容的那几份照常进候选（判据是内容不是 meta）',
      bkPlan.candidates.length === 1 && bkPlan.candidates[0].name === '20260102-000002',
      bkPlan.candidates.map((b) => b.name).join(','),
    )
    check(
      '★★ 最新两份永远留着（留足回退点）',
      !bkPlan.candidates.some((b) => b.name === '20260103-000003' || b.name === '20260104-000004'),
    )
    rmSync(bkRoot, { recursive: true, force: true })

    /* ══ ⑦ 备份真的能恢复（生产接口，逐字节比对） ══ */
    group('增长治理 / ⑦ 备份恢复：内容逐字节一致')
    const backup = require(join(ROOT, 'electron/core/backup.cjs'))
    const ps = require(join(ROOT, 'electron/core/paths.cjs'))
    const rootDir = ps.dataDir()
    const SESS = '用户：查 git log\n助手：12 条提交。\n'
    mkdirSync(join(rootDir, 'sessions'), { recursive: true })
    writeFileSync(join(rootDir, 'sessions/sess_g219000000001.jsonl'), SESS, 'utf8')
    writeFileSync(join(rootDir, 'config.json'), '{"version":2,"general":{"theme":"default"}}', 'utf8')

    const made = backup.create('manual')
    check('★ create 成功', made.ok === true, JSON.stringify(made).slice(0, 100))
    const bkFull = join(scan.backupRoot(), made.name)
    check(
      '★ 备份里的会话逐字节一致',
      readFileSync(join(bkFull, 'sessions/sess_g219000000001.jsonl'), 'utf8') === SESS,
    )

    writeFileSync(join(rootDir, 'sessions/sess_g219000000001.jsonl'), '改坏了\n', 'utf8')
    writeFileSync(join(rootDir, 'config.json'), '{"version":2,"general":{"theme":"dark"}}', 'utf8')
    const back = backup.restore(made.name)
    check('★ restore 成功', back.ok === true, JSON.stringify(back).slice(0, 100))
    check('★ 恢复时留了 safety 快照（恢复本身可回退）', Boolean(back.safetyBackup), back.safetyBackup)
    check(
      '★★ 会话内容回到原样（不是「看起来回来了」）',
      readFileSync(join(rootDir, 'sessions/sess_g219000000001.jsonl'), 'utf8') === SESS,
    )
    check(
      '★★ config 回到备份时的值（不是被改后的 dark）',
      JSON.parse(readFileSync(join(rootDir, 'config.json'), 'utf8')).general.theme === 'default',
    )

    /* ══ ⑧ 空壳备份拒绝恢复 / 非法名字挡住 ══ */
    group('增长治理 / ⑧ 坏备份不许盖掉好数据')
    const emptyName = '20990101-000001'
    const emptyDir = join(scan.backupRoot(), emptyName)
    mkdirSync(join(emptyDir, 'sessions'), { recursive: true })
    writeFileSync(join(emptyDir, 'meta.json'), JSON.stringify({ reason: 'auto', items: [] }), 'utf8')
    const emptyTry = backup.restore(emptyName)
    check(
      '★★ 空壳备份被拒绝恢复（否则拿空目录盖掉用户数据）',
      emptyTry.ok === false,
      String(emptyTry.error ?? '').slice(0, 60),
    )
    check(
      '★ 拒绝之后原来的会话还在',
      readFileSync(join(rootDir, 'sessions/sess_g219000000001.jsonl'), 'utf8') === SESS,
    )
    check('★★ 非法备份名（路径穿越）被白名单挡住', backup.restore('../sessions').ok === false)
    check('★ 不存在的备份报错而不是假装成功', backup.restore('20990101-000000').ok === false)

    /* ══ ⑨ 接线：三处清理真的在启动链里 ══ */
    group('增长治理 / ⑨ 接线：启动链真的会调这三处')
    const dataRetentionSrc = readFileSync(join(ROOT, 'electron/core/data-retention.cjs'), 'utf8')
    const growthSrc = readFileSync(join(ROOT, 'electron/core/growth-retention.cjs'), 'utf8')
    const bootSrc = readFileSync(join(ROOT, 'electron/boot-cleanup.cjs'), 'utf8')
    check('★ 启动清扫调了 pruneAll', bootSrc.includes('pruneAll()'))
    check('★★ growth 的三步都拼进了启动链', dataRetentionSrc.includes('growthRetention.steps()'))
    check(
      '★ 三步齐全',
      ['audit', 'changesets', 'backups'].every((k) => growthSrc.includes(`'${k}'`)),
    )
    check('★★ 清扫收尾会记状态（否则首次永远解除不了）', dataRetentionSrc.includes('finalizeSweep()'))
    check(
      '★ 有待批准积压时不记状态（继续只盘点，直到用户批准）',
      growthSrc.includes('pendingFile()'),
    )
  } finally {
    /* 恢复原状：别把自检的状态留给后面的组 */
    resetState()
    if (original.armed) writeFileSync(guard.armedFile(), JSON.stringify({ armed: true }), 'utf8')
  }
}
