/**
 * security:downloads —— 下载管理器（SEC-047 ~ 056）
 *
 * 用本机 mock HTTP 服务真跑下载引擎：Range 回退、错误 Content-Range、ETag 变化、
 * 失败与取消、路径穿越、台账迁移 —— 都是**观察到的行为**，不是源码字符串。
 */

import { sec } from '../harness.mjs'
import { fs, path, require, ROOT, tmpDir, startMockServer } from '../sandbox.mjs'

const join = path.join

/** 起一个可控的下载服务：可选忽略 Range / 固定 500 / 指定 ETag */
async function binaryServer(size, { etag = '"e1"', ignoreRange = false, always500 = false } = {}) {
  const body = Buffer.alloc(size, 7)
  return startMockServer((req, res) => {
    if (always500) {
      res.writeHead(500)
      res.end('boom')
      return
    }
    const range = req.headers.range
    if (range && !ignoreRange) {
      const m = /bytes=(\d+)-(\d*)/.exec(range)
      const start = Number(m[1])
      const end = m[2] ? Number(m[2]) : size - 1
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: etag })
      res.end(body.subarray(start, end + 1))
      return
    }
    res.writeHead(200, { 'Content-Length': size, ETag: etag, 'Accept-Ranges': ignoreRange ? 'none' : 'bytes' })
    res.end(body)
  })
}

/** SEC-047：服务端不支持 Range → 回退单连接，最终哈希正确 */
async function noRange(engine) {
  sec('SEC-047', engine.planFor(10 * 1024 * 1024, 4, false).wanted === 1, '不支持 Range → 单连接（不硬切段）')
  sec('SEC-047', engine.planFor(1000, 4, true).wanted === 1, '小文件（< MIN_SEGMENT_BYTES）不切段')
  sec('SEC-047', engine.planFor(10 * 1024 * 1024, 4, true).wanted === 4, '支持 Range 且够大 → 4 段')
  const size = 200 * 1024
  const server = await binaryServer(size, { ignoreRange: true })
  try {
    const file = join(tmpDir('dl-none'), 'f.bin')
    const r = await engine.downloadFile({ url: `${server.url}/f.bin`, file })
    sec('SEC-047', r.connections === 1, `无视 Range 的服务器回退单连接（connections=${r.connections}）`)
    sec('SEC-047', fs.readFileSync(file).length === size, `字节数正确（${fs.readFileSync(file).length}/${size}）`)
  } finally {
    await server.close()
  }
}

/** SEC-048：续传点存在但服务器不支持从中间续 → 拒绝，不产出错位成品 */
async function badRange(engine) {
  const size = 1000
  const server = await binaryServer(size, { ignoreRange: true, etag: 'X' })
  try {
    const dir = tmpDir('dl-bad')
    const file = join(dir, 'f.bin')
    fs.writeFileSync(`${file}.part`, Buffer.alloc(size))
    fs.writeFileSync(`${file}.part.json`, JSON.stringify({ url: `${server.url}/f.bin`, total: size, etag: 'X', segments: [{ start: 0, end: size - 1, received: 500 }] }))
    let err = ''
    try {
      await engine.downloadFile({ url: `${server.url}/f.bin`, file, retries: 0 })
    } catch (error) {
      err = error.message
    }
    sec('SEC-048', /不支持从中间续传|HTTP/.test(err), `从中间续却拿到 200 → 拒绝（${err.slice(0, 40)}）`)
    sec('SEC-048', !fs.existsSync(file), '不产出可能错位的成品文件')
  } finally {
    await server.close()
  }
}

/** SEC-049：续传时资源变化（ETag 不一致）→ 重下，绝不静默损坏 */
async function etagChanged(engine) {
  const size = 1000
  const server = await binaryServer(size, { etag: 'NEW' })
  try {
    const dir = tmpDir('dl-etag')
    const file = join(dir, 'f.bin')
    fs.writeFileSync(`${file}.part`, Buffer.alloc(size))
    fs.writeFileSync(`${file}.part.json`, JSON.stringify({ url: `${server.url}/f.bin`, total: size, etag: 'OLD', segments: [{ start: 0, end: size - 1, received: 500 }] }))
    const r = await engine.downloadFile({ url: `${server.url}/f.bin`, file })
    sec('SEC-049', r.resumed === false, 'ETag 变了 → 不续传，从头下')
    sec('SEC-049', r.bytes === size, `重下后字节完整（${r.bytes}/${size}）`)
    sec('SEC-049', fs.readFileSync(file).length === size, '成品大小正确（不静默损坏）')
  } finally {
    await server.close()
  }
}

/** SEC-050：网络失败 / 取消 —— 明确失败、不重复写入 */
async function failureAndCancel(engine) {
  const server = await binaryServer(1000, { always500: true })
  try {
    const file = join(tmpDir('dl-500'), 'f.bin')
    let err = ''
    try {
      await engine.downloadFile({ url: `${server.url}/f.bin`, file })
    } catch (error) {
      err = error.message
    }
    sec('SEC-050', /HTTP 500/.test(err), `服务器 5xx → 明确失败（${err.slice(0, 30)}）`)
    sec('SEC-050', !fs.existsSync(file), '失败时不产出成品')
  } finally {
    await server.close()
  }
  const s2 = await binaryServer(1000)
  try {
    const ac = new AbortController()
    ac.abort()
    const file = join(tmpDir('dl-cancel'), 'f.bin')
    let name = ''
    try {
      await engine.downloadFile({ url: `${s2.url}/f.bin`, file, signal: ac.signal })
    } catch (error) {
      name = error.name
    }
    sec('SEC-050', name === 'AbortError', `取消时按 AbortError 收场（${name}）`)
    sec('SEC-050', !fs.existsSync(file), '取消后不产出成品')
  } finally {
    await s2.close()
  }
}

/** SEC-051：强杀进程后恢复 —— 启动回落 + 不留临时残片 */
async function resumeAfterKill(engine, store) {
  const file = join(tmpDir('dl-resume'), 'f.bin')
  const a = store.add({ url: 'https://e.com/f.bin', file })
  store.patch(a.item.id, { status: 'running' })
  const fell = store.settle()
  sec('SEC-051', fell >= 1 && store.get(a.item.id).status === 'paused', `启动回落：running → paused（回落 ${fell} 条）`)
  const server = await binaryServer(4096)
  try {
    const done = join(tmpDir('dl-clean'), 'g.bin')
    await engine.downloadFile({ url: `${server.url}/g.bin`, file: done })
    sec('SEC-051', !fs.existsSync(`${done}.part`) && !fs.existsSync(`${done}.part.json`), '下完不留 .part / .part.json 残片')
  } finally {
    await server.close()
  }
}

/** SEC-052：文件名穿越与特殊字符 —— 最终路径限制在目标目录内 */
function nameTraversal(intake) {
  sec('SEC-052', intake.safeName('../../etc/passwd') === 'passwd', '服务器给的名字里的路径被剥掉')
  sec('SEC-052', !/[\\/]/.test(intake.safeName('a/b\\c.txt')), '名字里不带路径分隔符')
  const dir = tmpDir('dl-name')
  const t = intake.uniqueTarget(dir, intake.safeName('../../evil.txt'), () => false)
  sec('SEC-052', t.startsWith(dir + path.sep) && !t.split(path.sep).includes('..'), `最终路径落在目标目录内（${path.basename(t)}）`)
}

/** SEC-053：磁盘写不进 / 权限拒绝 → 明确失败，不误报成功 */
async function diskFailure(engine) {
  const dir = tmpDir('dl-fail')
  const blocker = join(dir, 'blocker')
  fs.writeFileSync(blocker, 'x')
  const file = join(blocker, 'f.bin')
  const server = await binaryServer(1000)
  try {
    let threw = false
    try {
      await engine.downloadFile({ url: `${server.url}/f.bin`, file })
    } catch {
      threw = true
    }
    sec('SEC-053', threw, '父路径是文件 → 明确失败（不误报成功）')
    sec('SEC-053', !fs.existsSync(file), '不产出半截成品')
  } finally {
    await server.close()
  }
}

/** SEC-054：并发 / 连接 / 限速受上限约束 */
function limits(store) {
  store.setLimits({ maxConcurrent: 999, connections: 999, maxKBps: -5 })
  const lim = store.getLimits()
  sec('SEC-054', lim.maxConcurrent <= 8 && lim.connections <= 16, `并发 / 连接被夹取（并发=${lim.maxConcurrent} 连接=${lim.connections}）`)
  sec('SEC-054', lim.maxKBps >= 0, `限速不为负（maxKBps=${lim.maxKBps}）`)
}

/** SEC-055：旧台账 / 损坏台账 —— 不静默丢有效任务，损坏不崩 */
function ledgerMigration(store) {
  store.setFilePathForTest(join(tmpDir('dl-ledger'), 'downloads.json'))
  fs.writeFileSync(store.filePath(), JSON.stringify({ items: [
    { id: 'a', file: 'E:/a', status: 'done' },
    { file: 'E:/noid' },
    { id: 'c' },
    null,
  ] }))
  const listed = store.list()
  const items = Array.isArray(listed) ? listed : (listed?.items ?? [])
  sec('SEC-055', items.some((i) => i.id === 'a'), '有效任务保留（不静默丢失）')
  sec('SEC-055', !items.some((i) => i.id === 'c') && items.length === 1, '缺字段条目被隔离（可诊断，不是全丢）')
  fs.writeFileSync(store.filePath(), '{ not json')
  let ok = false
  try {
    store.list()
    ok = true
  } catch {
    ok = false
  }
  sec('SEC-055', ok, '损坏台账不导致崩溃（fail-safe 到空）')
}

/** SEC-056：下载校验 —— 未知来源时不伪称已验证 */
async function verification(engine) {
  const size = 512
  const server = await binaryServer(size)
  try {
    const file = join(tmpDir('dl-verify'), 'f.bin')
    const r = await engine.downloadFile({ url: `${server.url}/f.bin`, file })
    const claims = ['verified', 'hash', 'sha256', 'md5'].some((k) => Boolean(r[k]))
    sec('SEC-056', !claims, '未知来源时不伪称已校验（结果里没有 verified/hash 声明）')
    sec('SEC-056', r.bytes === size && r.total === size, `字节 / 总长与源一致（${r.bytes}/${r.total}）`)
  } finally {
    await server.close()
  }
}

export async function run() {
  const engine = require(join(ROOT, 'electron/core/download-engine.cjs'))
  const store = require(join(ROOT, 'electron/core/download-store.cjs'))
  const intake = require(join(ROOT, 'electron/core/download-intake.cjs'))
  const steps = [
    ['SEC-047 服务端不支持 Range', () => noRange(engine)],
    ['SEC-048 Range 响应异常 / 错位', () => badRange(engine)],
    ['SEC-049 续传时资源变化', () => etagChanged(engine)],
    ['SEC-050 网络断开 / 重试 / 取消', () => failureAndCancel(engine)],
    ['SEC-051 强杀进程后恢复', () => resumeAfterKill(engine, store)],
    ['SEC-052 文件名穿越与特殊字符', () => nameTraversal(intake)],
    ['SEC-053 磁盘写满 / 权限拒绝', () => diskFailure(engine)],
    ['SEC-054 并发限速与资源上限', () => limits(store)],
    ['SEC-056 下载校验', () => verification(engine)],
    ['SEC-055 旧台账 / 损坏台账迁移', () => ledgerMigration(store)],
  ]
  for (const [label, fn] of steps) {
    console.log(`\n· ${label}`)
    try {
      await fn()
    } catch (error) {
      sec(label.slice(0, 7), false, `套件抛错：${error instanceof Error ? error.message : error}`)
    }
  }
}
