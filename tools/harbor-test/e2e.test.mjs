import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installerWorkspace, retryStatus } from './e2e.mjs'
import { stageInstaller } from './installer-adapter.mjs'
import { stageRegenProbe } from './regen-adapter.mjs'
import { ROOT } from './manifest.mjs'

test('accept-extension preload 只重定向到隔离安装目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harbor-installer-preload-'))
  const script = join(dir, 'accept-extension.cjs')
  const resultFile = join(dir, 'result.json')
  writeFileSync(script, [
    "const path = require('node:path')",
    "const BASE = path.resolve(__dirname, '..')",
    "const DIST = path.join(BASE, 'dist', 'sidepanel')",
    "const INSTALL = path.join(BASE, 'install-host.cmd')",
    "const UNINSTALL = path.join(BASE, 'uninstall-host.cmd')",
    "const PROFILE = 'profile-1c2-accept'",
    "let installArgs = null",
    "const runCmd = (file, args = []) => { installArgs = args; return 0 }",
    "if (runCmd(INSTALL) !== 0) throw new Error('install-host.cmd 失败')",
    "require('node:fs').writeFileSync(process.env.RESULT_FILE, JSON.stringify({ DIST, INSTALL, UNINSTALL, PROFILE, installArgs }))",
  ].join('\n'))
  const workspace = installerWorkspace(dir)
  const child = spawnSync(process.execPath, ['--require', join(ROOT, 'tools', 'harbor-test', 'e2e-preload.cjs'), script], {
    encoding: 'utf8',
    env: { ...process.env, HARBOR_TEST_SCRIPT: script, HARBOR_TEST_PROFILE_ROOT: join(dir, 'profiles'), HARBOR_TEST_INSTALLER_DIR: workspace, HARBOR_TEST_PORT_BASE: '24000', HARBOR_TEST_ATTEMPT: 'test-run-1', HARBOR_TEST_EXTENSION_ID: 'a'.repeat(32), HARBOR_INSTALL_DIR: join(dir, 'installed-copy'), RESULT_FILE: resultFile },
  })
  try {
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(readFileSync(resultFile, 'utf8'))
    assert.equal(result.DIST, join(workspace, 'dist', 'sidepanel'))
    assert.equal(result.INSTALL, join(workspace, 'install-host.cmd'))
    assert.equal(result.UNINSTALL, join(workspace, 'uninstall-host.cmd'))
    assert.equal(result.PROFILE, 'profile-test-run-1')
    assert.deepEqual(result.installArgs, ['a'.repeat(32), join(dir, 'installed-copy')])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('安装器适配器只接受哈希和锚点匹配的副本', () => {
  const dir = mkdtempSync(join(ROOT, 'data', 'harbor-installer-adapter-'))
  try {
    const workspace = join(dir, 'installer-workspace')
    assert.equal(stageInstaller(ROOT, workspace, 24000), workspace)
    const probe = readFileSync(join(workspace, 'tools', 'read-extid.cjs'), 'utf8')
    assert.ok(probe.includes('waitMs: 10000'))
    const changed = join(dir, 'changed-install.cmd')
    writeFileSync(changed, 'set "EXT_ID=%~1"\n')
    assert.ok(readFileSync(changed, 'utf8').includes('EXT_ID'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ESM 重新生成探针只生成独立端口的隔离副本', () => {
  const dir = mkdtempSync(join(ROOT, 'data', 'harbor-regen-adapter-'))
  const target = join(dir, 'staged')
  try {
    const staged = stageRegenProbe({
      sourceFile: join(ROOT, 'harbor-edge', 'tools', 'accept-regen-real.mjs'),
      upstreamFile: join(ROOT, 'harbor-edge', 'tools', 'fake-regen-upstream.mjs'),
      targetDir: target,
      repoRoot: ROOT,
      electronExe: join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
      isolationDir: join(dir, 'evidence', 'unit-test-data'),
      requestLog: join(dir, 'evidence', 'requests.jsonl'),
      appPort: 24000,
      fakePort: 24001,
    })
    const source = readFileSync(staged.script, 'utf8')
    assert.ok(source.includes('const PORT = 24000'))
    assert.ok(source.includes('const FAKE_PORT = 24001'))
    assert.ok(source.includes(JSON.stringify(join(dir, 'evidence', 'unit-test-data'))))
    assert.ok(source.includes(JSON.stringify(join(target, 'fake-regen-upstream.mjs'))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ESM 探针端口段不能越过有效端口上限', () => {
  assert.throws(() => stageRegenProbe({ appPort: 65530, fakePort: 65531 }), /端口无效/)
})

test('单测数据根可指定为 data 下的独立目录', () => {
  const dir = mkdtempSync(join(ROOT, 'data', 'harbor-test', 'runs', 'path-test-'))
  const result = spawnSync(process.execPath, ['-e', `const { dataDir } = require(${JSON.stringify(join(ROOT, 'electron', 'core', 'paths.cjs'))}); process.stdout.write(dataDir())`], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HARBOR_UNIT_TEST: '1', HARBOR_UNIT_TEST_DATA_DIR: dir },
  })
  try {
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('单测数据根拒绝 data 下非本工具运行目录', () => {
  const dir = join(ROOT, 'data', 'unit-test-data')
  const result = spawnSync(process.execPath, ['-e', `const { dataDir } = require(${JSON.stringify(join(ROOT, 'electron', 'core', 'paths.cjs'))}); dataDir()`], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HARBOR_UNIT_TEST: '1', HARBOR_UNIT_TEST_DATA_DIR: dir },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /必须位于 data\/harbor-test\/runs 内/)
})

test('单测数据根拒绝离开项目 data 目录', () => {
  const result = spawnSync(process.execPath, ['-e', `const { dataDir } = require(${JSON.stringify(join(ROOT, 'electron', 'core', 'paths.cjs'))}); dataDir()`], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HARBOR_UNIT_TEST: '1', HARBOR_UNIT_TEST_DATA_DIR: tmpdir() },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /必须位于 data\/harbor-test\/runs 内/)
})

test('两次判据失败才标真红', () => {
  assert.equal(retryStatus('FAIL_ASSERTION', 'FAIL_ASSERTION'), 'FAIL_ASSERTION')
  assert.equal(retryStatus('FAIL_INFRA', 'FAIL_ASSERTION'), 'FAIL_INFRA')
  assert.equal(retryStatus('FAIL_ASSERTION', undefined), 'SUSPECT')
})

test('失败后通过标为抖动，不冒充全绿', () => {
  assert.equal(retryStatus('FAIL_ASSERTION', 'PASS'), 'FLAKY')
  assert.equal(retryStatus('FAIL_INFRA', 'PASS'), 'FLAKY')
})
