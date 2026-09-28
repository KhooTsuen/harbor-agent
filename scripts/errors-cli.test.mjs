/* CLI 层的测试：真跑 `node scripts/errors.mjs`，验证参数、筛选、导出与「不写 data/」的铁律。
 *
 * 为什么单独一个文件：夹具要起子进程，和规则层那些纯函数测试不是一类事。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const CLI = path.resolve(import.meta.dirname, 'errors.mjs')

/** 造一份「有真错误 + 有噪音」的假数据目录 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'errors-cli-'))
  const now = Date.now()
  const stamp = new Date(now - 60_000).toISOString()
  const write = (rel, text) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text)
  }
  write('logs/today.log', `[${stamp}] [ERROR] fetch failed to api.example.com\n[${stamp}] [ERROR] selftest-crashed-123456\n`)
  write(
    'audit/a.jsonl',
    [
      JSON.stringify({ ts: now - 30_000, sessionId: 'sess_real', tool: 'read_file', ok: false, error: '文件不存在：/home/me/notes.txt' }),
      JSON.stringify({ ts: now - 20_000, sessionId: 'sess_real', tool: 'write_file', ok: false, error: '只读模式拒绝' }),
      JSON.stringify({ ts: now - 10_000, sessionId: 'selftest', tool: 'read_file', ok: false, error: '文件不存在：/x' }),
    ].join('\n') + '\n',
  )
  return { root, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const runCli = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000 })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('CLI：默认窗口能跑，且把噪音与真错误分开列', () => {
  const { root, done } = fixture()
  try {
    const r = runCli([`--data=${root}`, '--since=24h'])
    assert.equal(r.status, 0)
    assert.match(r.out, /发现 \d+ 条错误/)
    assert.match(r.out, /过滤噪音/, '必须报出过滤了多少噪音')
    assert.match(r.out, /fetch failed/, '真错误要出现')
    assert.ok(!/selftest-crashed/.test(r.out), '自检噪音不该出现在错误清单里')
  } finally {
    done()
  }
})

test('CLI：--source / --category / --severity 真的能筛（用夹具证明，不靠真实数据恰好有）', () => {
  const { root, done } = fixture()
  try {
    const onlyLog = runCli([`--data=${root}`, '--since=24h', '--source=log'])
    assert.match(onlyLog.out, /fetch failed/)
    assert.ok(!/文件不存在/.test(onlyLog.out), '--source=log 时不该出现 audit 里的错')

    const onlyAudit = runCli([`--data=${root}`, '--since=24h', '--source=audit'])
    assert.match(onlyAudit.out, /文件不存在/)
    assert.ok(!/fetch failed/.test(onlyAudit.out))

    const onlyMissing = runCli([`--data=${root}`, '--since=24h', '--category=file_missing'])
    assert.match(onlyMissing.out, /文件不存在/)
    assert.ok(!/fetch failed/.test(onlyMissing.out), '--category 要真的过滤')

    const onlyP1 = runCli([`--data=${root}`, '--since=24h', '--severity=P1'])
    assert.ok(!/fetch failed/.test(onlyP1.out), 'fetch failed 是 P2，不该出现在 --severity=P1 里')
  } finally {
    done()
  }
})

test('CLI：--json 是纯 JSON（程序能直接 parse）', () => {
  const { root, done } = fixture()
  try {
    const r = runCli([`--data=${root}`, '--since=24h', '--json'])
    const parsed = JSON.parse(r.out)
    assert.equal(typeof parsed.stats.real, 'number')
    assert.ok(Array.isArray(parsed.errors))
    assert.ok(parsed.errors.every((e) => e.severity && e.kind && e.message))
  } finally {
    done()
  }
})

test('CLI：按设计拒绝单独一节，不混在错误里', () => {
  const { root, done } = fixture()
  try {
    const r = runCli([`--data=${root}`, '--since=24h'])
    assert.match(r.out, /按设计拒绝/)
    const errorSection = r.out.split('按设计拒绝')[0]
    assert.ok(!/只读模式拒绝/.test(errorSection), '「只读模式拒绝」不该出现在错误清单里')
  } finally {
    done()
  }
})

test('CLI 铁律：拒绝把导出写进数据目录（工具只读数据）', () => {
  const { root, done } = fixture()
  try {
    const target = path.join(root, 'should-not-exist.md')
    const r = runCli([`--data=${root}`, `--export=${target}`])
    assert.notEqual(r.status, 0, '应该以非 0 退出')
    assert.match(r.out, /拒绝写入/)
    assert.equal(fs.existsSync(target), false, '文件不该被创建')
  } finally {
    done()
  }
})

test('CLI：--export 能写出 Markdown，含统计与 TOP 5', () => {
  const { root, done } = fixture()
  const outFile = path.join(os.tmpdir(), `errors-report-${Date.now()}.md`)
  try {
    const r = runCli([`--data=${root}`, `--export=${outFile}`])
    assert.equal(r.status, 0)
    const md = fs.readFileSync(outFile, 'utf8')
    for (const key of ['## 总览', '## 按严重性', '## 按分类', '## TOP 5 高频错误', '## 被过滤的噪音']) {
      assert.ok(md.includes(key), `报告里应该有「${key}」`)
    }
  } finally {
    fs.rmSync(outFile, { force: true })
    done()
  }
})

test('CLI：--noise 能看到被过滤的明细（过滤规则可被审计）', () => {
  const { root, done } = fixture()
  try {
    const r = runCli([`--data=${root}`, '--since=24h', '--noise'])
    assert.match(r.out, /噪音明细/)
    assert.match(r.out, /selftest/, '明细里要能看到被过滤的自检记录')
  } finally {
    done()
  }
})

test('CLI：时间写错时给得出人话，而不是崩栈', () => {
  const r = runCli(['--since=昨天'])
  assert.notEqual(r.status, 0)
  assert.match(r.out, /看不懂的时间/)
  assert.ok(!/at Object|\bstack\b/i.test(r.out), '不该吐堆栈')
})
