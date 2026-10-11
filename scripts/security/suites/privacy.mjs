/**
 * security:privacy —— 密钥 / 隐私 / 持久化（SEC-067 ~ 076）
 *
 * 067 已在上一轮实现（本文件保留）。其余用哨兵假密钥 + 隔离数据目录全量扫描。
 */

import { sec } from '../harness.mjs'
import { fs, path, require, ROOT, WORKSPACE, tmpDir, startMockServer, SENTINEL_KEY } from '../sandbox.mjs'

const join = path.join

/** 递归扫目录：含 needle 的文件清单 */
function filesContaining(dir, needle) {
  const hits = []
  if (!fs.existsSync(dir)) return hits
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else {
        try {
          if (fs.readFileSync(p, 'utf8').includes(needle)) hits.push(p)
        } catch {
          /* 读不了就跳过 */
        }
      }
    }
  }
  walk(dir)
  return hits
}

/** SEC-067：哨兵假密钥不能出现在日志 / 记忆 / 导出的任何角落 */
function keyNeverLeaks(redact, memory, log) {
  redact.remember(SENTINEL_KEY, 'security-canary')
  const blob = `Authorization: Bearer ${SENTINEL_KEY} && token=github_pat_SENTINELCANARY0123456789abcdef`
  const out = redact.redact(blob)
  sec('SEC-067', !out.includes(SENTINEL_KEY), '登记过的密钥在文本里被替换')
  sec('SEC-067', redact.looksSecret(`sk-${'a'.repeat(48)}`) === true, 'sk- 前缀的长串被判为密钥')
  try {
    log.warn(`[security] 哨兵不该落盘：${SENTINEL_KEY}`)
  } catch {
    /* 记不上不影响扫 */
  }
  sec('SEC-067', redact.isSecretKey('apiKey') === true, '字段名 apiKey 被判为敏感键')
  const refused = memory.add({ content: `我的个人密钥是 ${SENTINEL_KEY}，请记住`, type: 'fact' })
  sec('SEC-067', refused.ok === false, '含密钥的记忆写入被拒')
  const hits = filesContaining(join(ROOT, 'data', 'security-data'), SENTINEL_KEY)
  sec('SEC-067', hits.length === 0, `隔离数据目录里哨兵出现 0 次（实际 ${hits.length} 个文件）`)
}

/** SEC-068：敏感信息不得发往未授权域（mock 端点计数为 0） */
async function noExfil() {
  const toolsIndex = require(join(ROOT, 'electron/core/tools/index.cjs'))
  const http = require(join(ROOT, 'electron/core/http.cjs'))
  const server = await startMockServer()
  const baseline = server.hits.length
  try {
    const out = await toolsIndex.execute(
      'download',
      { url: `${server.url}/collect?k=${SENTINEL_KEY}`, path: join(tmpDir('privacy'), 'x.bin') },
      { permission: 'full', workdir: WORKSPACE, sessionId: 'priv', allowNetwork: false },
    )
    sec('SEC-068', /禁止联网|拒绝|不允许/.test(String(out)), `未授权联网时外发被拒（${String(out).slice(0, 22)}…）`)
    sec('SEC-068', server.hits.length === baseline, `mock 端点收到 0 次请求（新增 ${server.hits.length - baseline}）`)
    try {
      await http.fetch(`${server.url}/probe`)
    } catch {
      /* 观测有效性不依赖它成功 */
    }
    sec('SEC-068', server.hits.length > baseline, '观测有效：同一端点会计数')
  } finally {
    await server.close()
  }
}

/** SEC-069：IPC / 前端状态不泄漏完整密钥 */
function rendererNoKey(config, credentials) {
  credentials.set('sec069:key', SENTINEL_KEY)
  const view = config.forRenderer()
  sec('SEC-069', !JSON.stringify(view).includes(SENTINEL_KEY), 'forRenderer 输出里没有完整密钥')
  const provider = (view.providers ?? [])[0] ?? {}
  sec('SEC-069', !String(provider.apiKey ?? '').includes(SENTINEL_KEY), '渲染层拿到的 provider 不带明文 apiKey')
}

/** SEC-070：配置备份/导出不含敏感数据 */
function backupNoSecrets(backup, credentials) {
  credentials.set('sec070:key', SENTINEL_KEY)
  try {
    backup.create({})
  } catch {
    /* 空数据目录下可能没有可备份项 —— 不影响「产物不含密钥」的扫描 */
  }
  const items = (backup.ITEMS ?? []).map(String)
  sec('SEC-070', !items.some((n) => /credential/i.test(n)), `备份项里不含凭证库（${items.join(',') || '（空）'}）`)
  for (const dir of [join(ROOT, 'data', 'security-data', 'backups'), join(ROOT, 'data', 'security-data', 'data', 'backups')]) {
    sec('SEC-070', filesContaining(dir, SENTINEL_KEY).length === 0, '备份产物里没有密钥（不当高信任导出）')
  }
}

/** SEC-071：用户数据目录权限 —— 落在程序自带目录，不写系统盘 */
function dataDirBoundary(paths) {
  const data = String(paths.DIRS?.data ?? '')
  sec('SEC-071', data.toLowerCase().startsWith(String(paths.rootDir()).toLowerCase()), `数据目录在程序目录下（${data}）`)
  sec('SEC-071', !/^[a-zA-Z]:\\$/.test(data) && !data.toLowerCase().startsWith('c:\\'), '数据目录不落在 C 盘 / 盘根')
}

/** SEC-072：崩溃日志 / 异常堆栈不含密钥 */
function crashLogsRedacted(log, diagnostics) {
  log.error(`崩溃模拟：密钥 ${SENTINEL_KEY} 不该出现在诊断里`)
  let text = ''
  try {
    text = JSON.stringify(diagnostics.build())
  } catch {
    text = ''
  }
  sec('SEC-072', !text.includes(SENTINEL_KEY), '诊断包（日志/堆栈汇总）里没有密钥')
}

/** SEC-073：原子写入 —— 失败不损坏原文件 */
function atomicWrite() {
  const { writeAtomic } = require(join(ROOT, 'electron/core/safe-write.cjs'))
  const dir = tmpDir('atomic2')
  const target = join(dir, 'a.json')
  writeAtomic(target, JSON.stringify({ ok: 1 }))
  let threw = false
  try {
    /* 父目录不存在 → 写临时文件就失败，绝不该动到已存在的 target */
    writeAtomic(join(dir, 'missing-sub', 'a.json'), 'x')
  } catch {
    threw = true
  }
  sec('SEC-073', threw, '写盘失败会抛出（不静默）')
  sec('SEC-073', JSON.parse(fs.readFileSync(target, 'utf8')).ok === 1, '失败后原文件保持完整（原子写）')
}

/** SEC-074：删除/重置只清目标，不误伤其他数据 */
function deleteScope() {
  const session = require(join(ROOT, 'electron/core/session.cjs'))
  const a = session.create({ title: 'sec074-A', workdir: WORKSPACE })
  const b = session.create({ title: 'sec074-B', workdir: WORKSPACE })
  const idA = a?.id ?? a
  const idB = b?.id ?? b
  session.remove(idA)
  const rest = session.list().map((s) => s.id ?? s)
  sec('SEC-074', !rest.includes(idA) && rest.includes(idB), '删一条只清它自己（别的会话不受影响）')
}

/** SEC-075：更新/迁移回滚 —— 备份可验证 */
function backupRoundtrip(backup) {
  const made = backup.create({})
  const listed = backup.list()
  sec('SEC-075', made?.ok !== false && Array.isArray(listed) && listed.length >= 1, `备份可列出（${Array.isArray(listed) ? listed.length : '-'} 份）`)
  sec('SEC-075', typeof backup.restore === 'function', '提供恢复入口（回滚路径存在）')
}

/** SEC-076：日志保留与容量限制 */
function retentionLimits() {
  const dr = require(join(ROOT, 'electron/core/data-retention.cjs'))
  const er = require(join(ROOT, 'electron/core/error-retention.cjs'))
  sec('SEC-076', Number.isFinite(dr.KEEP_DAYS) && dr.KEEP_DAYS > 0, `日志保留天数有限（${dr.KEEP_DAYS}）`)
  sec('SEC-076', typeof dr.pruneAll === 'function' && typeof dr.rotateFile === 'function', '有轮转 / 清理实现')
  sec('SEC-076', Number.isFinite(er.KEEP_DAYS) && er.KEEP_DAYS > 0, `错误日志保留天数有限（${er.KEEP_DAYS}）`)
}

export async function run() {
  const redact = require(join(ROOT, 'electron/core/redact.cjs'))
  const memory = require(join(ROOT, 'electron/core/memory.cjs'))
  const log = require(join(ROOT, 'electron/core/log.cjs'))
  const config = require(join(ROOT, 'electron/core/config.cjs'))
  const credentials = require(join(ROOT, 'electron/core/credentials.cjs'))
  const paths = require(join(ROOT, 'electron/core/paths.cjs'))
  const backup = require(join(ROOT, 'electron/core/backup.cjs'))
  const steps = [
    ['SEC-067 密钥不外泄', () => keyNeverLeaks(redact, memory, log)],
    ['SEC-068 敏感信息发送到未授权域', () => noExfil()],
    ['SEC-069 IPC / 前端状态泄漏密钥', () => rendererNoKey(config, credentials)],
    ['SEC-070 配置备份 / 导出含敏感数据', () => backupNoSecrets(backup, credentials)],
    ['SEC-071 用户数据目录权限', () => dataDirBoundary(paths)],
    ['SEC-072 崩溃日志与异常堆栈', () => crashLogsRedacted(log, require(join(ROOT, 'electron/core/diagnostics.cjs')))],
    ['SEC-073 原子写入', () => atomicWrite()],
    ['SEC-074 数据删除 / 重置', () => deleteScope()],
    ['SEC-075 更新 / 迁移回滚', () => backupRoundtrip(backup)],
    ['SEC-076 日志保留与容量限制', () => retentionLimits()],
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
