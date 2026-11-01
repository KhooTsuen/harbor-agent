import { rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, targetInfo, verifyStages } from './harbor-test/manifest.mjs'
import { classify, duplicateNames, parseSelf, parseUnit, parseVerify } from './harbor-test/parse.mjs'
import { acquireLock, copyInstalled, hash, makeRunDir, npmSpec, runProcess } from './harbor-test/run.mjs'
import { runE2e } from './harbor-test/e2e.mjs'
import { compare, markdown, readBaseline, readPrevious, writeReport } from './harbor-test/report.mjs'
import { canTui, choose, color, finishProgress, progress, showReport } from './harbor-test/tui.mjs'

const argv = process.argv.slice(2)
const opt = (name) => argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3)
const plain = argv.includes('--plain') || !canTui()
const help = '用法：npm run harbor-test -- <unit|self|e2e|all> --target=<source|installed> [--script=accept-sidepanel] [--diff] [--html] [--plain] [-v]'

function gitInfo() {
  const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  return { commit: rev.stdout?.trim() || 'unknown', dirty: Boolean(dirty.stdout?.trim()) }
}

function stage(id, status, reason, extras = {}) { return { id, status, reason, passed: null, failed: null, items: [], durationMs: 0, ...extras } }

function specFor(suite) {
  if (suite === 'self') return { ...npmSpec('test'), parse: parseSelf, timeoutMs: 12 * 60_000 }
  if (suite === 'unit') return { ...npmSpec('test:unit'), parse: parseUnit, timeoutMs: 15 * 60_000 }
  return { ...npmSpec('verify'), parse: parseVerify, timeoutMs: 30 * 60_000 }
}

async function runSource(suite, run) {
  const spec = specFor(suite)
  progress(`正在测试源码版：${suite} …`, plain)
  const result = await runProcess({ ...spec, cwd: ROOT, dir: join(run.dir, suite), timeoutMs: spec.timeoutMs })
  finishProgress(plain)
  if (suite === 'all') {
    const parsed = parseVerify(result.output)
    const seen = new Set(parsed.seen)
    for (const name of verifyStages) {
      if (!seen.has(name)) run.stages.push(stage(name, 'NOT_RUN', '前面的验证阶段中断，本阶段未执行'))
      else if (name === 'test:unit' || name === 'test') {
        const p = name === 'test:unit' ? parsed.unit : parsed.self
        const status = classify(result.exitCode === 0 || seen.has('build') ? 0 : p.failed > 0 ? 1 : 0, p)
        const duplicateCount = duplicateNames(p.items).length
        run.stages.push(stage(name, status, status === 'PASS' ? '' : '请核对本阶段原始日志', { ...p, warnings: duplicateCount ? [`${duplicateCount} 个同组判据名重复，比较时需按出现顺序区分`] : [], durationMs: result.durationMs, exitCode: result.exitCode }))
      } else if (name === 'security' && parsed.security) {
        const status = parsed.security.fail > 0 ? 'FAIL_ASSERTION' : result.exitCode === 0 || seen.has('build') ? 'PASS' : 'SUSPECT'
        const reason = status === 'PASS' ? '' : parsed.security.failures.length ? `安全检查未通过：${parsed.security.failures.join('；')}` : '安全检查未通过，详见日志'
        run.stages.push(stage(name, status, reason, { passed: parsed.security.pass, failed: parsed.security.fail, durationMs: result.durationMs }))
      } else {
        const last = parsed.seen.at(-1)
        const status = result.exitCode !== 0 && last === name ? 'FAIL_INFRA' : 'PASS'
        run.stages.push(stage(name, status, status === 'PASS' ? '' : '此阶段中断或退出非零；详见日志', { durationMs: result.durationMs }))
      }
    }
    return result.exitCode === 0
  }
  const parsed = spec.parse(result.output)
  const status = result.cancelled ? 'FAIL_INFRA' : classify(result.exitCode, parsed, result.timedOut)
  const duplicates = duplicateNames(parsed.items)
  run.stages.push(stage(suite, status, result.cancelled ? '用户中止了测试，已保存已取得的证据' : result.spawnError || (status === 'SUSPECT' ? '汇总缺失、零判据或输出与退出码冲突' : ''), {
    ...parsed, warnings: duplicates.length ? [`${duplicates.length} 个同组判据名重复，比较时需按出现顺序区分`] : [], durationMs: result.durationMs, exitCode: result.exitCode, sourceHash: hash(suite === 'self' ? join(ROOT, 'scripts', 'selftest.mjs') : join(ROOT, 'vitest.config.ts')),
  }))
  return status === 'PASS'
}

async function runInstalled(suite, run) {
  if (suite === 'e2e') { await runE2e(run, opt('script'), { progress: (x) => progress(x, plain), finish: () => finishProgress(plain) }); return }
  if (suite === 'unit' || suite === 'self') {
    run.stages.push(stage(suite, 'NOT_APPLICABLE', '安装包没有源码或测试依赖；请改选 source 运行'))
    return
  }
  progress('正在复制安装版程序文件到隔离目录 …', plain)
  let copy
  try { copy = copyInstalled(run.target, run.dir) } catch (error) {
    finishProgress(plain)
    run.stages.push(stage('installed-self-test', 'FAIL_INFRA', error.message))
    return
  }
  finishProgress(plain)
  progress('正在测试安装版隔离副本 …', plain)
  const result = await runProcess({ file: copy.exe, args: ['--self-test'], cwd: copy.copy, dir: join(run.dir, 'installed-self-test'), timeoutMs: 4 * 60_000 })
  finishProgress(plain)
  const channels = result.output.match(/"channelsOk"\s*:\s*(true|false)/)
  const missing = result.output.match(/"channelsMissing"\s*:\s*\[([^\]]*)\]/)
  const okay = channels?.[1] === 'true' && missing?.[1].trim() === '' && result.exitCode === 0
  run.stages.push(stage('installed-self-test', okay ? 'PASS' : result.exitCode === 0 ? 'SUSPECT' : 'FAIL_INFRA', okay ? '' : '应用自检未确认 IPC 完整；详见日志', { passed: okay ? 1 : 0, failed: okay ? 0 : 1, durationMs: result.durationMs, exitCode: result.exitCode, sourceHash: copy.sourceHash }))
  if (okay) {
    const base = resolve(run.dir) + sep
    const candidate = resolve(copy.copy)
    if (candidate.startsWith(base) && candidate === resolve(run.dir, 'installed-copy')) rmSync(candidate, { recursive: true, force: true })
  }
  if (suite === 'all') {
    for (const name of ['unit', 'self', 'verify']) run.stages.push(stage(name, 'NOT_APPLICABLE', '安装版没有源码测试入口'))
    if (okay) await runE2e(run, opt('script'), { progress: (x) => progress(x, plain), finish: () => finishProgress(plain) })
    else run.stages.push(stage('e2e', 'NOT_RUN', '安装版自检未通过，未启动真机验收'))
  }
}

async function main() {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(help); return 0 }
  let suite = argv.find((x) => ['unit', 'self', 'e2e', 'all'].includes(x))
  let targetKind = opt('target')
  if (!suite && argv.includes('--diff')) {
    const target = targetInfo(targetKind || 'source', opt('installed-path'))
    const query = { ...target, scope: opt('scope') || 'all' }
    const latest = readBaseline(query)
    const previous = readPrevious(query)
    if (latest) {
      const md = markdown(latest, compare(latest, previous))
      if (canTui(argv.includes('--plain'))) await showReport(md, latest.dir)
      else console.log(md)
    } else console.log('还没有可比较的历史结果。')
    return 0
  }
  if (!suite && canTui()) { const picked = await choose(); if (!picked) return 0; suite = picked.suite; targetKind = picked.target }
  if (!suite || !targetKind) { console.log(help); return 2 }
  const target = targetInfo(targetKind, opt('installed-path'))
  const release = acquireLock()
  try {
    const { id, dir } = makeRunDir()
    const run = { schemaVersion: 1, id, dir, scope: suite === 'e2e' && opt('script') ? `e2e-${opt('script')}` : suite, target, startedAt: new Date().toISOString(), git: gitInfo(), stages: [] }
    if (target.kind === 'source') {
      if (suite === 'e2e') await runE2e(run, opt('script'), { progress: (x) => progress(x, plain), finish: () => finishProgress(plain) })
      else {
        const okay = await runSource(suite, run)
        if (suite === 'all') {
          if (okay) await runE2e(run, opt('script'), { progress: (x) => progress(x, plain), finish: () => finishProgress(plain) })
          else run.stages.push(stage('e2e', 'NOT_RUN', '全链未通过，真机验收未启动'))
        }
      }
    } else await runInstalled(suite, run)
    run.finishedAt = new Date().toISOString()
    const { md } = writeReport(run, argv.includes('--html'))
    console.log(color(run.stages.every((x) => x.status === 'PASS') ? 'PASS' : 'SUSPECT', `\n报告已保存：${join(dir, 'report.md')}`, plain))
    if (canTui(argv.includes('--plain'))) await showReport(md, dir)
    else console.log(md)
    if (argv.includes('-v')) console.log(JSON.stringify(run.stages.map((s) => ({ id: s.id, status: s.status, exitCode: s.exitCode, durationMs: s.durationMs, passed: s.passed, failed: s.failed })), null, 2))
    return run.stages.every((x) => x.status === 'PASS') ? 0 : 1
  } finally { release() }
}

main().then((code) => { process.exitCode = code }).catch((error) => { console.error(`测试运行器出错：${error.message}`); process.exitCode = 2 })
