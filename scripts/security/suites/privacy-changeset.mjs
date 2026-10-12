/**
 * security:privacy 的改动事务专项（SEC-073：meta 覆盖写保护）
 *
 * 从 `privacy.mjs` 拆出来的（那边贴着 300 行红线）。放在 `suites/` 下但**不是套件**：
 * `run.mjs` 只按 `cases.mjs` 的 SUITES 名单精确 `import('./suites/<名>.mjs')`，不扫目录。
 *
 * 隔离：`sandbox.mjs` 已 `paths.markPackaged(data/security-data)`，全程虚构数据，
 * **不碰任何真实事务 / 会话 / 用户文件**。
 */

import { sec, mark } from '../harness.mjs'
import { fs, path, require, ROOT, tmpDir } from '../sandbox.mjs'

const join = path.join

/** 造一个「写到 n 字节就抛 ENOSPC」的写函数 —— 只对 file 及其 .tmp-* 临时文件生效 */
function breaking(file, n, realWrite) {
  return (p, data, ...rest) => {
    if (typeof p === 'string' && p.startsWith(file)) {
      realWrite.call(fs, p, String(data).slice(0, n), 'utf8')
      const error = new Error('ENOSPC: no space left on device')
      error.code = 'ENOSPC'
      throw error
    }
    return realWrite.call(fs, p, data, ...rest)
  }
}

/** ① 覆盖写中断：旧 meta 必须一字未改、失败抛出、readMeta 仍可返回 */
function writeInterrupt(changeset, realWrite) {
  const work = tmpDir('cs-meta')
  const target = join(work, 'a.txt')
  fs.writeFileSync(target, 'ORIGINAL\n', 'utf8')

  const s = changeset.begin({ taskId: '', sessionId: '', title: 'sec073-cs' })
  if (!s.ok) {
    mark('SEC-073', 'BLOCKED', '改动事务未启用（config.changeset.enabled=false）')
    return
  }
  changeset.record(s.id, target)
  const dir = join(changeset.root(), s.id)
  const metaPath = join(dir, 'meta.json')
  const before = fs.readFileSync(metaPath, 'utf8')

  fs.writeFileSync = breaking(metaPath, 20, realWrite)
  let threw = false
  try {
    changeset.commit(s.id)
  } catch {
    threw = true
  } finally {
    fs.writeFileSync = realWrite
  }

  sec('SEC-073', threw, '改动事务 meta 写入失败会抛出（不假报成功）')
  sec('SEC-073', fs.readFileSync(metaPath, 'utf8') === before, 'meta 写入中断后，事务凭据一字未改')
  const meta = changeset.readMeta(s.id)
  sec('SEC-073', Boolean(meta) && meta.status === 'open', '中断后 readMeta 仍能返回原 meta（没被截断）')

  /* 负向：同样的注入打在「裸写」上 → 文件确实被截断，证明上面的保护断言不是恒真 */
  const bare = join(tmpDir('cs-bare'), 'meta.json')
  realWrite.call(fs, bare, JSON.stringify({ id: 'cs_bare', status: 'open', files: [1, 2, 3] }), 'utf8')
  const bareBefore = fs.readFileSync(bare, 'utf8')
  fs.writeFileSync = breaking(bare, 15, realWrite)
  try {
    fs.writeFileSync(bare, JSON.stringify({ id: 'cs_bare', status: 'committed', files: [1, 2, 3] }), 'utf8')
  } catch {
    /* 裸写抛了就对了 */
  } finally {
    fs.writeFileSync = realWrite
  }
  sec('SEC-073', fs.readFileSync(bare, 'utf8') !== bareBefore,
    '（负向）退回裸写时同样的注入会截断 meta —— 证明上面的保护断言能失败')

  fs.rmSync(dir, { recursive: true, force: true })
}

/** ② 损坏读取：留档 + 报警（不静默 null）+ 不删原件 + 不重复留档 */
function corruptMeta(changeset, errors) {
  const s = changeset.begin({ taskId: '', sessionId: '', title: 'sec073-cs-bad' })
  if (!s.ok) return
  const dir = join(changeset.root(), s.id)
  const metaPath = join(dir, 'meta.json')
  fs.writeFileSync(metaPath, '{ this is not json', 'utf8')
  const copies = () => fs.readdirSync(dir).filter((f) => f.startsWith('meta.json.corrupt-'))

  errors.length = 0
  const meta = changeset.readMeta(s.id)
  sec('SEC-073', meta === null, '损坏的 meta 读不出来（返回 null，不崩）')
  sec('SEC-073', errors.some((m) => m.includes('改动事务')), '损坏读取有报警（不静默 null）')
  sec('SEC-073', fs.existsSync(metaPath), '损坏的原始 meta 没被删除 / 覆盖')
  sec('SEC-073', copies().length === 1, `损坏文件留档一份（${copies().length}）`)

  const before = copies().length
  changeset.readMeta(s.id)
  sec('SEC-073', copies().length === before, '重复读取不重复留档（同一份只留一次）')

  fs.rmSync(dir, { recursive: true, force: true })
}

/** ③ 不存在的 meta（ENOENT）不能被误判为损坏 */
function missingMeta(changeset, errors) {
  const dir = join(changeset.root(), 'cs_sec073_ghost')
  fs.rmSync(dir, { recursive: true, force: true })
  errors.length = 0
  sec('SEC-073', changeset.readMeta('cs_sec073_ghost') === null, '不存在的 meta 返回 null')
  sec('SEC-073', errors.length === 0, '「文件不在」不被当成损坏（无报警、不留档）')
  sec('SEC-073', !fs.existsSync(dir), '不存在的 meta 不会凭空建目录')
}

/** ④ 正常流程不回归：begin / record / commit / list / get */
function normalFlow(changeset) {
  const s = changeset.begin({ taskId: 'sec073t', sessionId: 'sec073s', title: 'sec073-flow' })
  if (!s.ok) return
  const f = join(tmpDir('cs-flow'), 'x.txt')
  fs.writeFileSync(f, 'X0', 'utf8')
  changeset.record(s.id, f)
  const c = changeset.commit(s.id, { verified: true })
  sec('SEC-073', c.ok === true, '正常流程：begin / record / commit 不回归')
  sec('SEC-073', changeset.list({ taskId: 'sec073t' }).some((x) => x.id === s.id), '提交后事务仍能被 list 列出')
  sec('SEC-073', changeset.get(s.id)?.status === 'committed', 'get 读回 committed 状态')
  fs.rmSync(join(changeset.root(), s.id), { recursive: true, force: true })
}

/** 挂到 SEC-073：改动事务 meta 的写入与损坏保护 */
export function changesetMetaProtection() {
  const changeset = require(join(ROOT, 'electron/core/changeset.cjs'))
  const log = require(join(ROOT, 'electron/core/log.cjs'))
  const realWrite = fs.writeFileSync
  const realError = log.error
  const errors = []
  log.error = (m) => errors.push(String(m))
  try {
    writeInterrupt(changeset, realWrite)
    corruptMeta(changeset, errors)
    missingMeta(changeset, errors)
    normalFlow(changeset)
  } finally {
    log.error = realError
    fs.writeFileSync = realWrite
  }
}
