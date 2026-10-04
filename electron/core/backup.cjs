/**
 * 自动备份
 *
 * 备份「用户自己的数据」到 data/backups/<时间戳>/。恢复就是把文件拷回去。
 *
 * 为什么只备这几样：config（配置）、memory（记忆）、sessions（对话）、skills（技能）。
 * 日志是排错用的、缓存能重建，备了只是浪费空间。
 * `data/errors`（内核记的错误，见 error-observer.cjs）**故意不备**：同一类东西 ——
 * 它是诊断材料，随时能用 `npm run errors --export` 再生成一份，而且留 30 天后会被自动清理。
 *
 * 为什么用目录拷贝而不是打包压缩：用户能直接进去看、单独拿一个文件出来。
 * 这个软件本来就是「文件都在文件夹里」的形态，备份也跟着这个逻辑走。
 *
 * 便携版有个真实风险：整个文件夹拷到 U 盘时中途拔了，data 就残了 ——
 * 所以启动时会（每 24 小时）自动备一份。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
/* 清单 / 路径 / 算体积 / 列出备份都在 backup-scan.cjs（那边是只读的一半，
   加完「空壳备份」防护后这个文件过 300 行了，按职责拆的） */
const { KEEP, ITEMS, backupRoot, stamp, hasContent, dirSize, list, isBackupName } =
  require('./backup-scan.cjs')

/** 自动备份的间隔 */
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 超量就删最旧的 */
function prune() {
  const all = list()
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

/**
 * 做一次备份。
 *
 * @param {string} reason  'manual' | 'auto' | 'before-restore'
 */
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

    fs.writeFileSync(
      path.join(finalTarget, 'meta.json'),
      JSON.stringify(
        { reason, items: copied, skipped, createdAt: new Date().toISOString(), version: 1 },
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
    size: dirSize(finalTarget),
    items: copied,
    skipped,
    removed,
  }
}

/**
 * 启动时调：距上次备份超过一天就自动备一份。
 * 用备份目录里最新一份的时间来判断，不额外存状态 —— 少一个可能不同步的地方。
 */
function maybeAuto() {
  const all = list()
  const newest = all[0]
  if (newest && Date.now() - newest.createdAt < AUTO_INTERVAL_MS) {
    return { skipped: true, lastAt: newest.createdAt }
  }
  return create('auto')
}

/**
 * 恢复：先把当前数据备份一次（before-restore），再拷回去。
 * 恢复本身很危险，先留后路。
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

  const safety = create('before-restore')
  const restored = []
  const skipped = []

  try {
    for (const item of ITEMS) {
      const from = path.join(source, item.name)
      /* 备份里没有 / 只是空目录 → 跳过：绝不拿「没东西」盖用户现有的东西 */
      if (!hasContent(from)) {
        skipped.push(item.name)
        continue
      }
      const to = path.join(DIRS.data, item.name)
      /* 先删再拷：不然旧文件会混进来（比如已删的会话又活了） */
      fs.rmSync(to, { recursive: item.dir, force: true })
      fs.cpSync(from, to, { recursive: item.dir, force: true })
      restored.push(item.name)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(`恢复失败：${message}`)
    return {
      ok: false,
      error: message,
      safetyBackup: safety.ok ? safety.name : '',
    }
  }

  log.info(
    `已从 ${name} 恢复（${restored.join(', ')}）` +
      (skipped.length > 0 ? `；跳过这几项（备份里是空的）：${skipped.join(', ')}` : ''),
  )
  return {
    ok: true,
    restored,
    skipped,
    safetyBackup: safety.ok ? safety.name : '',
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

/** 打开备份目录（用系统文件管理器） */
function root() {
  return backupRoot()
}

module.exports = { create, list, restore, remove, maybeAuto, root, stamp, KEEP, ITEMS }