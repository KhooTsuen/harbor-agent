/* 错误观测工具：规则层的测试（分类 / 严重性 / 噪音 / 去重 / 时间解析）
 *
 * 用临时目录造夹具，**不读真实仓库数据** —— 真实数据每天都在变，
 * 拿它当断言对象的话，测试会变成「今天恰好没错误就绿」这种假绿。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { classify, severityOf, hintOf, dedupeKey, locationOf, classifierAvailable } from './errors/severity.mjs'
import { judge, lowTrust } from './errors/noise.mjs'
import { scan, parseSince } from './scan-errors.mjs'

/** 造一个假的数据目录 */
function fakeData(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'errors-'))
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text)
  }
  return { root, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const item = (over = {}) => ({ source: 'audit', ts: Date.now(), message: '出错了', location: 'audit:x', context: {}, ...over })

test('分类：复用内核分类器，认得出 network / file_missing', () => {
  assert.equal(classifierAvailable, true, '内核 errors.cjs 应该能被 require（自检就是这么用它的）')
  assert.equal(classify('fetch failed').kind, 'network')
  assert.equal(classify('文件不存在：x.txt').kind, 'file_missing')
  assert.equal(classify('rate limit exceeded').kind, 'rate_limit')
})

test('分类：事件流里的重试单独立一类（不然会落到 unknown，看着像未知故障）', () => {
  assert.equal(classify('agent.retrying（第 1 次尝试）', { source: 'event' }).kind, 'retry')
})

test('严重性：unknown 不升到 P0（分类器认不出 ≠ 阻塞）', () => {
  /* 内核对 unknown 也返回 needsUser=true，照抄会把「认不出」说成「阻塞」 */
  assert.equal(severityOf('unknown', { needsUser: true }), 'P3')
  assert.equal(severityOf('auth', { needsUser: true }), 'P0')
  assert.equal(severityOf('network', { retryable: true }), 'P2')
  assert.equal(severityOf('permission', { retryable: false }), 'P1')
  assert.equal(severityOf('unknown', { denied: true }), 'P3')
})

test('严重性：IPC 通道没注册这类高信号消息要升到 P1，并给人话建议', () => {
  const msg = '有 101 个 IPC 通道没注册上：app:quit, audit:clear'
  assert.equal(severityOf('mcp', { message: msg }), 'P1')
  assert.match(hintOf('mcp', msg), /按钮点不动/)
})

test('噪音：自检工具名 / 自检路径 / 测试夹具 id / 自检字样 都要判成噪音', () => {
  assert.equal(judge(item({ context: { tool: 'probe_secret' } })).verdict, 'noise')
  assert.equal(judge(item({ context: { args: { path: 'E:/x/data/selftest-workspace/a.txt' } } })).verdict, 'noise')
  assert.equal(judge(item({ context: { taskId: 'selftest-events-1756' } })).verdict, 'noise')
  assert.equal(judge(item({ context: { sessionId: 'break-test' } })).verdict, 'noise')
  assert.equal(judge(item({ message: 'selftest-crashed-1790624505954' })).verdict, 'noise')
  assert.equal(judge(item({ context: { args: { path: 'E:/CodexWorkbench/test-env/PersonalAgent/data/workspace/x.txt' } } })).verdict, 'noise')
})

test('噪音：真实用户错误**不许**被判成噪音', () => {
  assert.equal(judge(item({ message: 'fetch failed', context: { tool: 'read_file', taskId: 'task_abc', sessionId: 'sess_1' } })).verdict, 'error')
  assert.equal(judge(item({ message: '文件不存在：E:\\我的项目\\notes.txt', context: { tool: 'read_file' } })).verdict, 'error')
})

test('噪音：按设计拒绝单独归一类（安全机制正常工作，不是故障）', () => {
  const v = judge(item({ message: '只读模式拒绝', context: { tool: 'write_file' } }))
  assert.equal(v.verdict, 'expected_denial')
})

test('可信度：审计 ok=false 但没写原因的要标低可信', () => {
  assert.ok(lowTrust(item({ source: 'audit', message: '（审计里 ok=false，但没写 error 文本）' })))
  assert.equal(lowTrust(item({ source: 'log', message: 'x' })), null)
})

test('去重键：只差数字的会合并（重试/序号变化），名字不同的不合并（那是两个文件）', () => {
  /* 这条口径是有取舍的：数字会被抹平 → 「换个序号的同一个错」能合并成一条（count 累加）；
     代价是「log1.txt / log2.txt」这种只差数字的**不同文件**也会并成一条。
     取舍理由：重复出现的报错里，数字更多是 id/序号/时间，而不是「文件名本身有意义」。 */
  const a = dedupeKey('file_missing', { source: 'audit', location: 'audit:read_file', message: '文件不存在：/tmp/x1.txt' })
  const b = dedupeKey('file_missing', { source: 'audit', location: 'audit:read_file', message: '文件不存在：/tmp/x2.txt' })
  assert.equal(a, b)
  const diffName = dedupeKey('file_missing', { source: 'audit', location: 'audit:read_file', message: '文件不存在：/tmp/notes.txt' })
  assert.notEqual(a, diffName, '文件名不同 = 两个错，不该合并')
  const diffPlace = dedupeKey('file_missing', { source: 'audit', location: 'audit:edit_file', message: '文件不存在：/tmp/x1.txt' })
  assert.notEqual(a, diffPlace, '位置（哪个工具）不同不该合并')
})

test('位置：五种来源都能给出可查坐标', () => {
  assert.equal(locationOf({ source: 'log', location: '2026-09-29.log' }), '2026-09-29.log')
  assert.equal(locationOf({ source: 'task', location: 'task:t1.steps[2]' }), 'task:t1.steps[2]')
})

test('时间解析：24h / 7d / 90m / ISO 都认，乱写的要报错', () => {
  const now = Date.parse('2026-09-29T12:00:00+08:00')
  assert.equal(parseSince('24h', now), now - 24 * 3600 * 1000)
  assert.equal(parseSince('7d', now), now - 7 * 86_400_000)
  assert.equal(parseSince('90m', now), now - 90 * 60_000)
  assert.equal(parseSince('2026-09-29T00:00:00+08:00', now), Date.parse('2026-09-29T00:00:00+08:00'))
  assert.throws(() => parseSince('昨天', now), /看不懂的时间/)
})

test('扫描：五类源都能读，且只取错误（logs 的 WARN 单独计数）', () => {
  const now = Date.now()
  const stamp = new Date(now - 60_000).toISOString()
  const { root, done } = fakeData({
    'logs/today.log': `[${stamp}] [INFO] 正常\n[${stamp}] [WARN] 一个降级\n[${stamp}] [ERROR] fetch failed\n`,
    'audit/a.jsonl': `${JSON.stringify({ ts: now - 50_000, sessionId: 's1', tool: 'read_file', ok: false, error: '文件不存在：/home/me/a.txt' })}\n${JSON.stringify({ ts: now - 40_000, sessionId: 's1', tool: 'read_file', ok: true })}\n`,
    'tasks/t1.json': JSON.stringify({ id: 't1', title: '做点事', status: 'failed', sessionId: 's1', updatedAt: now - 30_000, errors: [{ message: '速率限制：429' }], steps: [{ ok: false, error: '超时了', tool: 'run_shell' }] }),
    'events/e.jsonl': `${JSON.stringify({ taskId: 't1', timestamp: now - 20_000, type: 'agent.retrying', payload: { attempt: 1 } })}\n${JSON.stringify({ taskId: 't1', timestamp: now - 19_000, type: 'agent.thinking', payload: {} })}\n`,
    'sessions/s1.jsonl': `${JSON.stringify({ type: 'meta', id: 's1' })}\n${JSON.stringify({ ts: now - 10_000, error: '连接被重置' })}\n`,
  })
  try {
    const r = scan({ dataDir: root, since: now - 3600_000 })
    assert.equal(r.ok, true)
    assert.equal(r.stats.warnCount, 1, 'WARN 要单独计数，不混进错误')
    const kinds = r.entries.map((e) => e.kind).sort()
    assert.ok(kinds.includes('network'), `日志里的 fetch failed 要认出来：${kinds}`)
    assert.ok(kinds.includes('file_missing'))
    assert.ok(kinds.includes('rate_limit'))
    assert.ok(r.entries.some((e) => e.kind === 'timeout' || e.message.includes('超时')), '任务步骤失败要进来')
    assert.ok(r.stats.retries >= 1, '重试要单独统计')
    assert.ok(r.entries.every((e) => e.kind !== 'retry'), '重试不该混进错误清单')
    assert.equal(r.stats.bySeverity.P0 ?? 0, 0, '这批里没有必须人处理的')
  } finally {
    done()
  }
})

test('扫描：去重后 count 增加，而不是新增条目', () => {
  const now = Date.now()
  const line = (i, msg) => JSON.stringify({ ts: now - 1000 * i, sessionId: 's1', tool: 'read_file', ok: false, error: msg })
  const { root, done } = fakeData({
    'audit/a.jsonl': [line(5, '文件不存在：/tmp/a1.txt'), line(4, '文件不存在：/tmp/a2.txt'), line(3, '文件不存在：/tmp/a3.txt')].join('\n') + '\n',
  })
  try {
    const r = scan({ dataDir: root, since: now - 3600_000 })
    assert.equal(r.entries.length, 1, `三条应合成一条，实际 ${r.entries.length}`)
    assert.equal(r.entries[0].count, 3)
    assert.ok(r.entries[0].firstSeen <= r.entries[0].lastSeen)
  } finally {
    done()
  }
})

test('扫描：数据目录不存在时优雅返回，不抛异常', () => {
  const r = scan({ dataDir: 'e:/no-such-dir-xyz', since: Date.now() - 1000 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有数据目录/)
})
