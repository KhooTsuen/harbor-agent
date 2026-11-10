/**
 * 自动备份：用户数据 → data/backups/<时间戳>/。恢复就是把文件拷回去。
 *
 * 只备 config / memory / sessions / skills / tasks / changesets —— 都**删了不可重建**。
 * 凭证库有意不备（DPAPI 密文再复制一份没意义）；日志与 errors 是诊断材料，能再生成。
 * 用目录拷贝而非打包：用户能直接进去看、单独拿一个文件出来。
 * 便携版有真实风险（整个文件夹拷到 U 盘时中途拔了），所以启动时每 24 小时自动备一份。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
/* 清单 / 路径 / 算体积 / 列出备份都在 backup-scan.cjs（只读的一半）；体积实现在 backup-size.cjs */
const { KEEP, ITEMS, backupRoot, stamp, hasContent, dirSize, list, listAsync, isBackupName } =
  require('./backup-scan.cjs')
/* 第 13 项：恢复过程中被强杀时认得出「未完成」（标记见 backup-restore-mark.cjs） */
const restoreMark = require('./backup-restore-mark.cjs')

/** 自动备份的间隔 */
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 超量就删最旧的。体积不需要 → 走缓存，不扫盘（见 backup-scan 的 sizes 选项） */
function prune() {
  const all = list(backupRoot(), { sizes: 'cache' })
  const removed = []
  for (const old of all.slice(KEEP)) {
    try {
      fs.rmSync(old.path, { recursive: true, force: true })
      removed.push(old.name)
    } catch (error) {
      log.warn(`删旧备份失败 ${old.name}：${error instanceof Error ? error.message : error}`)
    }
  }
  return removed
}

/** 做一次备份。reason: 'manual' | 'auto' | 'before-restore' */
function create(reason = 'manual') {
  const name = stamp()
  const target = path.join(backupRoot(), name)

  /* 同一秒内重复触发（连点按钮）就顺延，别覆盖上一份 */
  let finalTarget = target
  let suffix = 1
  while (fs.existsSync(finalTarget)) {
    finalTarget = `${target}-${suffix++}`
  }

  const copied = []
  const skipped = []
  /* 备份完的体积：写进 meta（下次 list 不必再扫），也直接当返回值 */
  let createdBytes = 0
  try {
    fs.mkdirSync(finalTarget, { recursive: true })

    for (const item of ITEMS) {
      const source = path.join(DIRS.data, item.name)
      /* 没有 / 空 → 跳过，但**要说出来**（以前静默跳过 = 清单里写有记忆、其实没备） */
      if (!hasContent(source)) {
        skipped.push(item.name)
        continue
      }
      const dest = path.join(finalTarget, item.name)
      fs.cpSync(source, dest, { recursive: item.dir, force: true })
      copied.push(item.name)
    }

    /* 一个用户项都没拷到 = 这份备份毫无用处，别留着（首启就会发生） */
    if (copied.length === 0) {
      fs.rmSync(finalTarget, { recursive: true, force: true })
      log.info(`没有可备份的用户数据（${skipped.join(', ') || '空'}），这一轮不出备份`)
      return { ok: false, skipped: true, error: '还没有可备份的数据（首次启动时正常）' }
    }

    if (skipped.length > 0) log.info(`备份跳过这几项（还没有 / 是空的）：${skipped.join(', ')}`)

    /* 体积在**备完这一刻**算一次并写进 meta：之后 list() 直接读它，不再为已备好的备份扫盘
       （不写这步的话，每次打开设置页都要重扫 12 份，实测 6~7 秒） */
    createdBytes = dirSize(finalTarget)

    fs.writeFileSync(
      path.join(finalTarget, 'meta.json'),
      JSON.stringify(
        {
          reason,
          items: copied,
          skipped,
          createdAt: new Date().toISOString(),
          version: 1,
          totalBytes: createdBytes,
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch (error) {
    /* 备份失败不能影响主流程，但要把半成品清掉免得被当成有效备份 */
    try {
      fs.rmSync(finalTarget, { recursive: true, force: true })
    } catch {
      /* 清不掉也只能算了 */
    }
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`备份失败：${message}`)
    return { ok: false, error: message }
  }

  const removed = prune()
  log.info(`已备份：${path.basename(finalTarget)}（${copied.join(', ')}）`)

  return {
    ok: true,
    name: path.basename(finalTarget),
    path: finalTarget,
    size: createdBytes,
    items: copied,
    skipped,
    removed,
  }
}

/**
 * 启动时调：距上次备份超过一天就自动备一份。
 * 只认**有 meta 且 items 非空**的备份判「上次什么时候备的」—— 2026-11-07 真机：
 * 一份手工拷进来、无 meta 的目录被当成最新备份，自动备份停了整整一天。
 * 老备份可能没有 meta → 退回「目录里有内容」也算数，不能只看 mtime。
 */
function lastRealBackupAt() {
  /*
   * ★ `sizes: 'cache'`（2026-11-08）：这里只看 `items` / `empty` / `createdAt`，
   *   **一个体积都不需要**。以前走默认的 `list()` 会为了算体积递归 statSync
   *   两万多个文件 —— 每次启动白卡 6~7 秒，只为判断「今天备过没」。
   */
  for (const one of list(backupRoot(), { sizes: 'cache' })) {
    /* `list()` 已经把 meta 读过了：`items` 非空 = 有 meta 且记了清单 */
    if (Array.isArray(one.items) && one.items.length > 0) return one.createdAt
    /* 老备份没有 meta：至少有用户数据也算数（不然会重复备份，但不是「不备」） */
    if (!one.empty) return one.createdAt
  }
  return 0
}

function maybeAuto() {
  const lastAt = lastRealBackupAt()
  if (lastAt && Date.now() - lastAt < AUTO_INTERVAL_MS) {
    return { skipped: true, lastAt }
  }
  return create('auto')
}

/**
 * 从一份快照把这几项拷回数据目录（**恢复失败时的回滚**）。
 *
 * 逐项：有就盖回（先删后拷，和 restore 同一套），快照里没有的就把数据目录里
 * 那一项删掉 —— 因为恢复中途可能已经删过它、拷了一半。返回成功回滚的项。
 */
function rollbackFrom(snapshot, names) {
  const from0 = path.join(backupRoot(), snapshot)
  const done = []
  for (const name of names) {
    const item = ITEMS.find((it) => it.name === name)
    if (!item) continue
    const from = path.join(from0, name)
    const to = path.join(DIRS.data, name)
    try {
      fs.rmSync(to, { recursive: item.dir, force: true })
      if (hasContent(from)) fs.cpSync(from, to, { recursive: item.dir, force: true })
      done.push(name)
    } catch (error) {
      log.error(`回滚 ${name} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
  return done
}

/**
 * 恢复：先把当前数据整份留成快照（before-restore），再逐项拷回去。
 *
 * ★ 破坏性操作（逐项「先删后建」），三条底线：① **留不下快照就不恢复**；
 * ② **中途失败就回滚**；③ **留不下恢复标记就不恢复**（第 13 项 —— 标记让重启后
 * 认得出「上次恢复被打断了」，见 backup-restore-mark.cjs）。
 */
function restore(name) {
  /* ★ 名字先过白名单（审计问题 14）：`restore('..\\..\\Windows')` 以前能拿任意
     目录盖数据。`name` 是从界面一层层传进来的，不能当成可信输入 */
  if (!isBackupName(name)) {
    return { ok: false, error: `备份名不合法（应该是 20260922-213954 这种时间戳）：${String(name).slice(0, 60)}` }
  }
  const source = path.join(backupRoot(), name)
  if (!fs.existsSync(source)) return { ok: false, error: `找不到备份 ${name}` }

  /* ★ 空壳恢复是**破坏性**的（拿空目录盖上去，对话与技能全没了）——
     界面已经禁了「恢复」，但界面只是壳，后端必须自己卡住（审计问题 13） */
  const usable = ITEMS.filter((item) => hasContent(path.join(source, item.name)))
  if (usable.length === 0) {
    return {
      ok: false,
      error: '这份备份里没有任何用户数据（空壳），恢复它只会清空当前数据 —— 已拒绝',
    }
  }

  /* ★ 底线①：先留后路，留不下来就绝不往下走（不删、不拷、原数据一字未动） */
  const safety = create('before-restore')
  if (!safety.ok) {
    return {
      ok: false,
      aborted: true,
      error: `恢复前给当前数据留快照失败（${safety.error ?? '未知原因'}）—— 已中止，未改动任何数据`,
    }
  }

  const restored = []
  const skipped = []
  /** 已经动过的项（删/拷过）—— 回滚时就按这份名单拷回 */
  const touched = []

  /* ★ 第 13 项：留标记，写不下就中止（没有它就无法识别「被打断」） */
  try {
    restoreMark.begin(name, safety.name)
  } catch (error) {
    return {
      ok: false,
      aborted: true,
      error: `留不下恢复标记（${error instanceof Error ? error.message : error}）—— 已中止，未改动任何数据`,
      safetyBackup: safety.name,
    }
  }

  try {
    for (const item of ITEMS) {
      const from = path.join(source, item.name)
      /* 备份里没有 / 只是空目录 → 跳过：绝不拿「没东西」盖用户现有的东西 */
      if (!hasContent(from)) {
        skipped.push(item.name)
        continue
      }
      const to = path.join(DIRS.data, item.name)
      touched.push(item.name)
      restoreMark.touch(item.name)
      /* 先删再拷：不然旧文件会混进来（比如已删的会话又活了） */
      fs.rmSync(to, { recursive: item.dir, force: true })
      fs.cpSync(from, to, { recursive: item.dir, force: true })
      restored.push(item.name)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(`恢复失败：${message} —— 正在从快照 ${safety.name} 回滚`)
    /* ★ 底线②：把动过的项拷回去，别把用户停在中间态 */
    const rolledBack = rollbackFrom(safety.name, touched)
    restoreMark.finish()
    return {
      ok: false,
      error: message,
      safetyBackup: safety.name,
      rolledBack,
      /** 回滚是否覆盖了所有动过的项 —— 界面据此提示「数据可能停在旧/中间态」 */
      rolledBackAll: rolledBack.length === touched.length,
    }
  }

  /* 走完 = 恢复完整；标记必须删掉，否则下次启动会误报「上次被打断」 */
  restoreMark.finish()
  log.info(
    `已从 ${name} 恢复（${restored.join(', ')}）` +
      (skipped.length > 0 ? `；跳过这几项（备份里是空的）：${skipped.join(', ')}` : ''),
  )
  return {
    ok: true,
    restored,
    skipped,
    safetyBackup: safety.name,
    needsRestart: true,
  }
}

function remove(name) {
  /* 同 restore：名字必须先是自己造的（审计问题 14）—— 这里更狠，
     `remove('..\\sessions')` 以前会直接把会话目录连着删掉 */
  if (!isBackupName(name)) {
    return { ok: false, error: '备份名不合法，拒绝删除' }
  }
  const target = path.join(backupRoot(), name)
  if (!fs.existsSync(target)) return { ok: false, error: '找不到这个备份' }
  try {
    fs.rmSync(target, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function root() {
  return backupRoot()
}

/* `listAsync` = IPC 用的异步版（体积带缓存、不等扫盘），见 backup-scan 的说明 */
module.exports = { create, list, listAsync, restore, remove, maybeAuto, root, stamp, KEEP, ITEMS }