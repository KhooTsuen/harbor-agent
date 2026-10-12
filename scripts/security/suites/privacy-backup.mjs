/**
 * security:privacy 的备份专项：清单断言（SEC-070）+ 恢复安全（SEC-075）
 *
 * 从 `privacy.mjs` 拆出来的（那边贴着 300 行红线）。放在 `suites/` 下但**不是套件**：
 * `run.mjs` 只按 `cases.mjs` 的 SUITES 名单精确 `import('./suites/<名>.mjs')`，不扫目录。
 *
 * 隔离：`sandbox.mjs` 已 `paths.markPackaged(data/security-data)`，全程虚构数据，
 * **不碰任何真实备份 / 真实用户数据**；每个场景跑完自己清掉造出来的东西。
 */

import { sec } from '../harness.mjs'
import { fs, path, require, ROOT } from '../sandbox.mjs'

const join = path.join
const DIRS = require(join(ROOT, 'electron/core/paths.cjs')).DIRS

/**
 * SEC-070：备份清单里不含凭证库。
 *
 * ★ 2026-10-13 修一个**空跑断言**：原来写 `(backup.ITEMS ?? []).map(String)` ——
 *   而 ITEMS 是 `[{ name, dir }]` 对象数组，`String({})` 得 `'[object Object]'`，
 *   正则 `/credential/` 永不匹配 → 这条断言**恒真**：真把 credentials.json 加进
 *   清单也不会红。这里取**真正的项名**，并补一条负向，证明它现在能被违反。
 */
export function backupItemNameCheck(backup) {
  const namesOf = (items) =>
    (items ?? []).map((it) => (typeof it === 'string' ? it : (it?.name ?? '')))
  const names = namesOf(backup.ITEMS)
  sec('SEC-070', !names.some((n) => /credential/i.test(n)), `备份项里不含凭证库（${names.join(',') || '（空）'}）`)
  /* 负向：把凭证塞进清单，同名判据必须能挑出来 —— 证明上一条不是恒真 */
  const withCred = namesOf([...(backup.ITEMS ?? []), { name: 'credentials.json', dir: false }])
  sec(
    'SEC-070',
    withCred.some((n) => /credential/i.test(n)),
    '（负向）清单里出现凭证时同名判据会命中 —— 证明上一条非空跑',
  )
}

/**
 * SEC-075：恢复必须**先留快照**、且**失败要回滚**。
 *
 * P0（2026-10-13）：恢复是逐项「先删后建」的破坏性操作，而 E2 起备份已含
 * tasks / changesets（不可重建的硬数据）。两条底线：
 *   ① 留不下快照就**中止**（不删、不拷）—— 绝不在没有退路时覆盖用户当前任务；
 *   ② 中途失败就**回滚**动过的项 —— 别让用户停在「一半新一半旧 / 某一项被清空」的中间态。
 */
export function backupRestoreSafety(backup) {
  const root = backup.root()
  const tasksDir = join(DIRS.data, 'tasks')
  const marker = join(tasksDir, 'sec075-current.json')
  const oldFile = join(tasksDir, 'sec075-old.json')
  const realCp = fs.cpSync

  const writeMarker = () => {
    fs.mkdirSync(tasksDir, { recursive: true })
    fs.writeFileSync(marker, 'CURRENT', 'utf8')
  }
  const markerIntact = () => {
    try {
      return fs.readFileSync(marker, 'utf8') === 'CURRENT'
    } catch {
      return false
    }
  }

  /* 造一份「来源备份」：只含 tasks（内容 OLD）—— 别的项都空，恢复时自然被跳过 */
  const srcName = '20200101-000000'
  const srcTasks = join(root, srcName, 'tasks')
  fs.rmSync(join(root, srcName), { recursive: true, force: true })
  fs.mkdirSync(srcTasks, { recursive: true })
  fs.writeFileSync(join(srcTasks, 'sec075-old.json'), 'OLD', 'utf8')

  try {
    /* ① 恢复前留快照失败 → 必须中止，当前数据一字未动 */
    writeMarker()
    fs.cpSync = (from, to, ...rest) => {
      /* 快照是往 backups/ 里拷贝 —— 往那儿拷就抛，模拟「留不下快照」 */
      if (typeof to === 'string' && to.startsWith(root)) throw new Error('EACCES: 模拟快照写失败')
      return realCp.call(fs, from, to, ...rest)
    }
    const aborted = backup.restore(srcName)
    fs.cpSync = realCp
    sec('SEC-075', aborted.ok === false, `留不下快照时恢复被拒（ok=${aborted.ok}）`)
    sec('SEC-075', aborted.aborted === true, '留不下快照时记为「已中止」')
    sec(
      'SEC-075',
      markerIntact() && !fs.existsSync(oldFile),
      '中止后当前数据一字未动（正在跑的任务还在，没被旧备份替换）',
    )

    /* ② 恢复中途失败 → 从快照回滚，别把用户停在中间态 */
    writeMarker()
    let fired = false
    fs.cpSync = (from, to, ...rest) => {
      /* 只对「往数据目录拷 tasks」这一下抛一次，让回滚（再拷一次）能成功 */
      if (!fired && typeof to === 'string' && to === tasksDir) {
        fired = true
        throw new Error('EACCES: 模拟恢复中途失败')
      }
      return realCp.call(fs, from, to, ...rest)
    }
    let rolled
    try {
      rolled = backup.restore(srcName)
    } finally {
      fs.cpSync = realCp
    }
    sec('SEC-075', rolled.ok === false, `恢复中途失败会如实报错（ok=${rolled.ok}）`)
    sec('SEC-075', rolled.rolledBackAll === true, `已回滚动过的项（rolledBack=${(rolled.rolledBack ?? []).join(',')}）`)
    sec('SEC-075', markerIntact(), '回滚后当前任务台账恢复原样（没被旧备份替换、没被清空）')
    sec('SEC-075', !fs.existsSync(oldFile), '回滚后旧备份内容没留下（不许停在旧态）')
  } finally {
    fs.cpSync = realCp
    fs.rmSync(join(root, srcName), { recursive: true, force: true })
  }
}
