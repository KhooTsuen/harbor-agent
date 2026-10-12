/**
 * security:privacy 的会话行专项（SEC-073：session-io.writeLines 覆盖写保护 + 损坏读取不再静默）
 *
 * 从 `privacy.mjs` 拆出来的（那边贴着 300 行红线）。放在 `suites/` 下但**不是套件**：
 * `run.mjs` 只按 `cases.mjs` 的 SUITES 名单精确 `import('./suites/<名>.mjs')`，不扫目录。
 *
 * 隔离：`sandbox.mjs` 已 `paths.markPackaged(data/security-data)`，全程虚构会话，
 * **不碰任何真实会话文件**。
 */

import { sec } from '../harness.mjs'
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

/** ① 覆盖写中断：已存在的会话文件在写入失败时一字未改，且失败要抛出 */
function writeInterrupt(io, session, realWrite) {
  const meta = session.create({ title: 'sec073-sess', mode: 'pair' })
  const id = meta.id
  const file = io.fileFor(id)
  const before = fs.readFileSync(file, 'utf8')

  fs.writeFileSync = breaking(file, 15, realWrite)
  let threw = false
  try {
    io.writeLines(id, [{ type: 'meta', id, title: '改过的标题' }])
  } catch {
    threw = true
  } finally {
    fs.writeFileSync = realWrite
  }

  sec('SEC-073', threw, '会话整篇写入失败会抛出（不假报成功）')
  sec('SEC-073', fs.readFileSync(file, 'utf8') === before, '会话写入中断后，原有内容一字未改')
  sec('SEC-073', io.readLines(id)[0]?.title === 'sec073-sess', '中断后仍能正常读回原 meta（没被截断）')

  /* 负向：同样的注入打在「裸写」上 → 文件确实被截断，证明上面的保护断言不是恒真 */
  const bare = join(tmpDir('sess-bare'), 'sess_barewrite.jsonl')
  realWrite.call(fs, bare, '{"type":"meta","title":"原始"}\n', 'utf8')
  const bareBefore = fs.readFileSync(bare, 'utf8')
  fs.writeFileSync = breaking(bare, 10, realWrite)
  try {
    fs.writeFileSync(bare, '{"type":"meta","title":"写了一半就断"}\n', 'utf8')
  } catch {
    /* 裸写抛了就对了 */
  } finally {
    fs.writeFileSync = realWrite
  }
  sec(
    'SEC-073',
    fs.readFileSync(bare, 'utf8') !== bareBefore,
    '（负向）退回裸写时同样的注入会截断会话文件 —— 证明上面的保护断言能失败',
  )

  session.remove(id)
}

/** ② 整篇损坏：留档 + 报警（不静默），且**克制**（同一份文件只留一次） */
function corruptWhole(io, session, errors) {
  const meta = session.create({ title: 'sec073-corrupt', mode: 'pair' })
  const id = meta.id
  const file = io.fileFor(id)
  fs.writeFileSync(file, '{ this is not json\n', 'utf8')

  const dir = path.dirname(file)
  const copies = () => fs.readdirSync(dir).filter((f) => f.startsWith(`${id}.jsonl.corrupt-`))

  errors.length = 0
  const rows = io.readLines(id)
  sec('SEC-073', Array.isArray(rows) && rows.length === 0, '整篇损坏的会话读出来是空的（不崩）')
  sec('SEC-073', errors.some((m) => m.includes('整篇读不出来')), '整篇损坏有 error 报警（不静默）')
  sec('SEC-073', fs.existsSync(file), '损坏的原始会话没被删除 / 覆盖')
  sec('SEC-073', copies().length === 1, `整篇损坏留档一份（${copies().length}）`)

  const before = copies().length
  io.readLines(id)
  sec('SEC-073', copies().length === before, '重复读取不重复留档（克制：不刷 .corrupt 副本）')

  session.remove(id)
}

/** ③ 部分损坏必须继续容忍（不回归）：坏行丢掉、好行照读、**不触发**整篇留档 */
function partialCorrupt(io, session) {
  const meta = session.create({ title: 'sec073-partial', mode: 'pair' })
  const id = meta.id
  const file = io.fileFor(id)
  fs.appendFileSync(file, '{ not json at all\n', 'utf8')
  fs.appendFileSync(file, `${io.serializeLine({ type: 'message', role: 'user', content: '好行' })}\n`, 'utf8')

  const dir = path.dirname(file)
  const copies = () => fs.readdirSync(dir).filter((f) => f.startsWith(`${id}.jsonl.corrupt-`))
  const rows = io.readLines(id)
  sec('SEC-073', rows.length === 2, `部分损坏：好行照读（读到 ${rows.length} 条）`)
  sec('SEC-073', rows.some((r) => r.type === 'message' && r.content === '好行'), '好行的内容没丢')
  sec('SEC-073', copies().length === 0, '部分损坏不触发整篇留档（克制）')

  session.remove(id)
}

/** ④ 不存在的会话（ENOENT）不能被误判为损坏 */
function missingSession(io, errors) {
  errors.length = 0
  const rows = io.readLines('sess_sec073ghost')
  sec('SEC-073', Array.isArray(rows) && rows.length === 0, '不存在的会话读出来是空数组（ENOENT 正常）')
  sec('SEC-073', errors.length === 0, '「文件不在」不被当成损坏（无 error、不留档）')
}

/** ⑤ 正常流程不回归：建会话 / 追加 / 读回 / 改标题 / 删 */
function normalFlow(session) {
  const meta = session.create({ title: 'sec073-flow', mode: 'pair' })
  session.append(meta.id, { role: 'user', content: '你好' })
  const loaded = session.load(meta.id)
  sec('SEC-073', loaded?.messages?.some((m) => m.content === '你好'), '正常流程：建会话 / 追加 / 读回不回归')
  const updated = session.updateMeta(meta.id, { title: '改过的标题' })
  sec('SEC-073', updated?.title === '改过的标题', 'updateMeta 仍能改标题')
  session.remove(meta.id)
}

/** 挂到 SEC-073：会话行写入与损坏读取的保护 */
export function sessionWriteProtection() {
  const io = require(join(ROOT, 'electron/core/session-io.cjs'))
  const session = require(join(ROOT, 'electron/core/session.cjs'))
  const log = require(join(ROOT, 'electron/core/log.cjs'))
  const realWrite = fs.writeFileSync
  const realError = log.error
  const errors = []
  log.error = (m) => errors.push(String(m))
  try {
    writeInterrupt(io, session, realWrite)
    corruptWhole(io, session, errors)
    partialCorrupt(io, session)
    missingSession(io, errors)
    normalFlow(session)
  } finally {
    log.error = realError
    fs.writeFileSync = realWrite
  }
}
