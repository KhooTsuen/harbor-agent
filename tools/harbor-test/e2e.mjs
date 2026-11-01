import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import net from 'node:net'
import redactor from '../../electron/core/redact.cjs'
import { e2eScripts, ROOT } from './manifest.mjs'
import { classify, duplicateNames, parseE2e } from './parse.mjs'
import { copyInstalled, hash, runProcess, saveJson } from './run.mjs'
import { installerWorkspace as adapterInstallerWorkspace, stageInstaller as stageInstallerAdapter } from './installer-adapter.mjs'
import { stageRegenProbe } from './regen-adapter.mjs'

export { installerWorkspace }

const KEY = 'HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\com.harbor.agent'
const UNIT = join(ROOT, 'data', 'unit-test-data')
const PRELOAD = join(ROOT, 'tools', 'harbor-test', 'e2e-preload.cjs')
const { redact } = redactor
const stage = (id, status, reason, extras = {}) => ({ id, status, reason, passed: null, failed: null, items: [], durationMs: 0, ...extras })
const inside = (base, file) => resolve(file).toLowerCase().startsWith((resolve(base) + sep).toLowerCase())

export function retryStatus(first, second) {
  if (first === 'PASS') return 'PASS'
  if (second === 'PASS') return 'FLAKY'
  if (first === 'FAIL_ASSERTION' && second === 'FAIL_ASSERTION') return 'FAIL_ASSERTION'
  if (first === 'FAIL_INFRA' || second === 'FAIL_INFRA') return 'FAIL_INFRA'
  return 'SUSPECT'
}

function registry() {
  return [64, 32].map((view) => {
    const r = spawnSync('reg', ['QUERY', KEY, '/ve', `/reg:${view}`], { encoding: 'utf8', windowsHide: true })
    return r.status === 0 ? (r.stdout.match(/REG_SZ\s+(.+)/)?.[1]?.trim() ?? '') : null
  })
}

function restoreRegistry(before) {
  for (let i = 0; i < 2; i++) {
    const view = [64, 32][i]
    const args = before[i] === null ? ['DELETE', KEY, '/f', `/reg:${view}`] : ['ADD', KEY, '/ve', '/t', 'REG_SZ', '/d', before[i], '/f', `/reg:${view}`]
    spawnSync('reg', args, { encoding: 'utf8', windowsHide: true })
  }
  return JSON.stringify(registry()) === JSON.stringify(before)
}

async function freePorts(base, count = 16) {
  for (let i = 0; i < count; i++) {
    const busy = await new Promise((done) => {
      const s = net.connect({ host: '127.0.0.1', port: base + i })
      s.once('connect', () => { s.destroy(); done(true) })
      s.once('error', () => done(false))
      s.setTimeout(400, () => { s.destroy(); done(false) })
    })
    if (busy) return false
  }
  return true
}

function safeRm(base, file) {
  if (!inside(base, file)) throw new Error(`拒绝删除隔离目录以外的路径：${file}`)
  rmSync(file, { recursive: true, force: true, maxRetries: 3 })
}

function dataSnapshot(dir, enabled = true) {
  const backup = join(dir, 'unit-data-before')
  if (!enabled) return { backup, present: false, enabled: false }
  if (existsSync(UNIT)) cpSync(UNIT, backup, { recursive: true })
  return { backup, present: existsSync(UNIT), enabled: true }
}

function restoreData(snapshot, dir) {
  if (!snapshot.enabled) return
  if (existsSync(UNIT)) safeRm(join(ROOT, 'data'), UNIT)
  if (snapshot.present) cpSync(snapshot.backup, UNIT, { recursive: true })
  if (snapshot.present) safeRm(dir, snapshot.backup)
}

function collect(dir, profileRoots, result, since, dataRoot = UNIT) {
  const evidence = join(dir, 'evidence')
  mkdirSync(evidence, { recursive: true })
  const found = []
  for (const profileRoot of profileRoots) {
    for (const file of ['Default/Secure Preferences', 'Default/Preferences', 'Local State', 'DevToolsActivePort']) {
      for (const profile of existsSync(profileRoot) ? readdirSync(profileRoot) : []) {
        const from = join(profileRoot, profile, ...file.split('/'))
        if (!existsSync(from) || statSync(from).isDirectory()) continue
        const to = join(evidence, `${profile}-${file.replaceAll('/', '-')}`)
        try { cpSync(from, to); found.push(to) } catch { /* 文件被 Edge 占用 */ }
      }
    }
  }
  const scan = (folder, depth = 0) => {
    if (!existsSync(folder) || depth > 2) return
    for (const name of readdirSync(folder)) {
      const file = join(folder, name)
      try {
        const info = statSync(file)
        if (info.isDirectory()) { scan(file, depth + 1); continue }
        if (info.mtimeMs < since - 1000 || !/\.(log|jsonl|png|jpg|html)$|stderr/i.test(name)) continue
        const label = file.slice(UNIT.length + 1).replace(/[\\/]/g, '-')
        const isText = /\.(log|jsonl)$|stderr/i.test(name)
        const dest = join(evidence, label + (isText ? '.tail.txt' : ''))
        if (isText) writeFileSync(dest, redact(readFileSync(file, 'utf8').slice(-50000)))
        else cpSync(file, dest)
      } catch { /* 单个证据文件不影响原始结果 */ }
    }
  }
  scan(dataRoot)
  saveJson(join(evidence, 'manifest.json'), { profileFiles: found, dataRoot, exitCode: result.exitCode, timedOut: result.timedOut, screenshot: '由原脚本生成时保留', domSnapshot: '由原脚本生成时保留' })
}

function sourceSignals(file) {
  const source = readFileSync(file, 'utf8')
  const matches = [...source.matchAll(/^\s*rec\([^,\n]+,\s*true\s*(?:,|\))/gm)]
  return matches.length ? [`源码中有 ${matches.length} 处判据直接传入 true，需人工核实观察依据`] : []
}

const installerWorkspace = adapterInstallerWorkspace
const stageInstaller = stageInstallerAdapter

async function attempt(script, run, index, hostExe) {
  const dir = join(run.dir, script.id, `attempt-${index}`)
  const profileRoot = join(dir, 'profiles')
  mkdirSync(profileRoot, { recursive: true })
  const before = registry()
  const snapshot = dataSnapshot(dir, script.id !== 'accept-regen-real')
  const portBase = 20000 + (Math.floor(Math.random() * 1500) * 16)
  if (!(await freePorts(portBase))) {
    const dataOk = (() => { try { restoreData(snapshot, dir); return true } catch { return false } })()
    return { status: 'FAIL_INFRA', reason: `独立端口段 ${portBase} 起已占用`, durationMs: 0, items: [], passed: null, failed: null, registryOk: true, dataOk }
  }
  let installerDir = ''
  let installerHostDir = ''
  let extensionId = ''
  let setupError = ''
  const attemptId = `${run.id}-${index}`.replace(/[^a-zA-Z0-9-]/g, '')
  if (script.id === 'accept-extension') {
    try {
      installerDir = stageInstallerAdapter(ROOT, installerWorkspace(dir), portBase)
      installerHostDir = run.target.kind === 'source'
        ? copyInstalled({ path: resolve(hostExe, '..') }, dir).copy
        : resolve(hostExe, '..')
      const probe = await runProcess({
        file: process.execPath,
        args: [join(installerDir, 'tools', 'read-extid.cjs'), `--ext=${join(installerDir, 'dist', 'sidepanel')}`, `--port=${portBase}`],
        cwd: ROOT,
        env: { HARBOR_TEST_ATTEMPT: attemptId, HARBOR_EDGE_PROFILE_ROOT: join(dir, 'installer-edge-profiles'), HARBOR_TEST_EXTID_PORT: String(portBase), HARBOR_TEST_KEEP_PROFILE: '1' },
        dir: join(dir, 'extension-id-probe'),
        timeoutMs: 90_000,
      })
      extensionId = probe.output.match(/\b[a-p]{32}\b/)?.[0] ?? ''
      if (probe.exitCode !== 0 || !extensionId) throw new Error('隔离扩展 ID 探针未返回有效 ID；详见 extension-id-probe 日志')
    } catch (error) {
      setupError = error.message
    }
  }
  const env = {
    HARBOR_UNIT_TEST: '1', HARBOR_TEST_SCRIPT: script.file, HARBOR_TEST_PROFILE_ROOT: profileRoot,
    HARBOR_TEST_INSTALLER_DIR: installerDir,
    HARBOR_INSTALL_DIR: installerHostDir,
    HARBOR_TEST_EXTENSION_ID: extensionId,
    HARBOR_TEST_HOST_EXE: hostExe || '', HARBOR_TEST_PORT_BASE: String(portBase),
    HARBOR_TEST_STAGE: dir,
    HARBOR_TEST_REG_BACKUP: join(dir, 'registry-backup.json'),
    HARBOR_TEST_ATTEMPT: attemptId, HARBOR_TEST_KEEP_PROFILE: '1',
  }
  let result, registryOk = false, dataOk = false
  const started = Date.now()
  try {
    if (setupError) throw new Error(setupError)
    if (script.id === 'accept-regen-real') {
      const regenDir = join(dir, 'staged', 'regen')
      const regenEvidence = join(dir, 'evidence', 'regen-isolation')
      const regen = stageRegenProbe({
        sourceFile: script.file,
        upstreamFile: join(ROOT, 'harbor-edge', 'tools', 'fake-regen-upstream.mjs'),
        targetDir: regenDir,
        repoRoot: ROOT,
        electronExe: join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
        isolationDir: join(regenEvidence, 'unit-test-data'),
        requestLog: join(regenEvidence, 'regen-requests.jsonl'),
        appPort: portBase,
        fakePort: portBase + 1,
      })
      result = await runProcess({ file: process.execPath, args: [regen.script], cwd: ROOT, env: { ...env, HARBOR_UNIT_TEST_DATA_DIR: join(dir, 'evidence', 'regen-isolation', 'unit-test-data') }, dir, timeoutMs: 5 * 60_000 })
    } else {
      result = await runProcess({ file: process.execPath, args: ['--require', PRELOAD, script.file], cwd: ROOT, env, dir, timeoutMs: 5 * 60_000 })
    }
    const dataRoot = script.id === 'accept-regen-real' ? join(dir, 'evidence', 'regen-isolation', 'unit-test-data') : UNIT
    collect(dir, script.id === 'accept-regen-real'
      ? [profileRoot, dataRoot]
      : [profileRoot, join(dir, 'installer-edge-profiles')], result, started, dataRoot)
  } catch (error) {
    result = { output: '', exitCode: 1, durationMs: 0, spawnError: error.message }
    saveJson(join(dir, 'runner-error.json'), { message: error.message })
  } finally {
    registryOk = restoreRegistry(before)
    try { restoreData(snapshot, dir); dataOk = true } catch { dataOk = false }
  }
  const parsed = parseE2e(result.output)
  let status = result.cancelled ? 'FAIL_INFRA' : classify(result.exitCode, parsed, result.timedOut)
  if (!registryOk || !dataOk) status = 'FAIL_INFRA'
  const failNames = parsed.items.filter((x) => x.status === 'fail').map((x) => x.name).slice(0, 3)
  const reason = !registryOk ? '注册表未恢复，队列必须停止' : !dataOk ? '测试数据未恢复，队列必须停止' :
    result.spawnError || (failNames.length ? `失败判据：${failNames.join('；')}` : status === 'FAIL_INFRA' ? '脚本或 Edge 启动异常，详见 stderr 和退出码' : '')
  if (status === 'PASS') {
    for (const profile of [profileRoot, join(dir, 'installer-edge-profiles'), join(dir, 'evidence', 'regen-isolation', 'profiles')]) {
      if (existsSync(profile)) safeRm(dir, profile)
    }
    if (existsSync(join(dir, 'evidence', 'regen-isolation'))) safeRm(dir, join(dir, 'evidence', 'regen-isolation'))
  }
  return { ...parsed, status, reason, durationMs: result.durationMs, exitCode: result.exitCode, cancelled: result.cancelled, registryOk, dataOk, dir, portBase, profileRoot, hostExe, hostHash: hash(hostExe) }
}

export async function runE2e(run, only, { progress = () => {}, finish = () => {} } = {}) {
  if (process.platform !== 'win32') { run.stages.push(stage('e2e', 'BLOCKED_ENV', '真机验收需要 Windows 和 Edge')); return }
  if (!existsSync(join(ROOT, 'harbor-edge', 'dist', 'sidepanel', 'manifest.json'))) { run.stages.push(stage('e2e', 'BLOCKED_ENV', '扩展构建产物不存在')); return }
  const selected = only ? e2eScripts.filter((x) => x.id === only) : e2eScripts
  if (!selected.length) { run.stages.push(stage('e2e', 'BLOCKED_ENV', `脚本不在允许清单：${only}`)); return }
  let hostExe = ''
  if (run.target.kind === 'installed') {
    try { hostExe = copyInstalled(run.target, run.dir).exe } catch (error) { run.stages.push(stage('e2e', 'FAIL_INFRA', error.message)); return }
  } else hostExe = join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe')
  if (!existsSync(hostExe)) { run.stages.push(stage('e2e', 'BLOCKED_ENV', '用于真机验收的 Harbor.exe 不存在')); return }
  for (const script of selected) {
    if (script.manual || script.externalHost) { run.stages.push(stage(script.id, 'NEEDS_HUMAN', script.manual ? '需要手动点击 Edge 工具栏图标' : '依赖既有 host 安装，需人工验收')); continue }
    if (script.id === 'accept-regen-real' && run.target.kind === 'installed') { run.stages.push(stage(script.id, 'NOT_APPLICABLE', '重新生成探针启动源码 Electron，仅对 source 目标有效')); continue }
    if (script.legacy && !only) { run.stages.push(stage(script.id, 'NOT_APPLICABLE', '早期探针要求已废弃的 Hello Harbor 页面')); continue }
    if (run.target.kind === 'installed' && script.id === 'accept-extension') { run.stages.push(stage(script.id, 'NOT_APPLICABLE', '此脚本验收的是源码扩展安装流程，不能证明便携版扩展入口')); continue }
    if (run.target.kind === 'installed' && /^(accept-m03|accept-m04a|accept-phase3b|accept-phase3c)$/.test(script.id)) {
      run.stages.push(stage(script.id, 'NOT_APPLICABLE', '此脚本启动源码 Electron 界面，不能证明便携版界面')); continue
    }
    progress(`真机验收：${script.id}，首次运行 …`)
    const first = await attempt(script, run, 1, hostExe)
    finish()
    let second = null
    if (first.status !== 'PASS' && !first.cancelled && first.registryOk !== false && first.dataOk !== false) {
      progress(`真机验收：${script.id}，失败后复测 …`)
      second = await attempt(script, run, 2, hostExe)
      finish()
    }
    const current = second || first
    let status = retryStatus(first.status, second?.status)
    if (script.legacy && status === 'FAIL_ASSERTION') status = 'SUSPECT'
    const warnings = [...sourceSignals(script.file)]
    const duplicates = duplicateNames(current.items ?? [])
    if (duplicates.length) warnings.push(`${duplicates.length} 个判据名称重复，历史比较可能对错项`)
    if (current.passed !== null && current.failed !== null && current.items?.length && current.passed + current.failed !== current.items.length) {
      warnings.push(`脚本汇总 ${current.passed + current.failed} 项，逐项日志只识别到 ${current.items.length} 项；需人工核对是否漏跑`)
    }
    if (status === 'FLAKY') warnings.push('首次失败、复测通过；环境抖动或不稳定判据，首次失败证据已保留')
    if (script.legacy) warnings.push('历史探针要求 Hello Harbor 页面；结果仅供兼容性观察')
    if (['accept-m02b', 'accept-ownership'].includes(script.id)) warnings.push('原脚本的注册表恢复调用参数错误；以外层恢复核验为准')
    if (status === 'PASS' && current.passed === 0) warnings.push('没有可核实的通过判据')
    run.stages.push(stage(script.id, status, status === 'FLAKY' ? '首次失败，复测通过；建议单独再跑一次' : current.reason, {
      ...current, status, warnings, attempts: [first, ...(second ? [second] : [])], sourceHash: hash(script.file),
    }))
    if (current.cancelled || first.cancelled || current.registryOk === false || current.dataOk === false || first.registryOk === false || first.dataOk === false) break
  }
  if (run.target.kind === 'installed' && run.stages.every((s) => s.status === 'PASS')) {
    safeRm(run.dir, join(run.dir, 'installed-copy'))
  }
}
