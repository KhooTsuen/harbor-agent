/**
 * 验收共用：装一台**隔离的** native host（Phase 3a 从 accept-phase2 抽出来）
 *
 * 「装 host」= 写一个 `.cmd` 包装器 + 写宿主清单 + 写注册表。三份验收脚本都要做，
 * 各抄一遍迟早漂（`.cmd` 那三条规矩很容易漏一条，见 harbor-host.cmd 的文件头）。
 *
 * ★ 隔离口径（与产线同机制、但绝不碰用户数据）：
 *   · 用**真 `Harbor.exe`** + `ELECTRON_RUN_AS_NODE=1`（生产同款，见
 *     docs/research/edge-extension-host-stdout-experiments.md）
 *   · `HARBOR_DATA_ROOT` 指到验收自己的数据根（页面内容只进隔离目录）
 *   · 宿主清单的 `allowed_origins` 用**真扩展 id**
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')

/** 写注册表（同时写 64 / 32 位视图 —— 官方搜索顺序里两个都查） */
function regAdd(name, manifestPath) {
  const out = []
  for (const view of ['/reg:64', '/reg:32']) {
    out.push(
      spawnSync('reg', ['ADD', `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${name}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', view], {
        encoding: 'utf8',
      }).status,
    )
  }
  return out
}

/** 删注册表（64 / 32 两位都删） */
function regDel(name) {
  for (const view of ['/reg:64', '/reg:32']) {
    spawnSync('reg', ['DELETE', `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${name}`, '/f', view], { encoding: 'utf8' })
  }
}

/**
 * 装一台隔离 host。
 *
 * @param {{ dataDir: string, extId: string, name: string, tag: string }} opts
 *   `tag` 用来区分同名文件（如 `p3a`），免得同一数据根下两份验收互相覆盖。
 * @returns {{ cmd: string, manifest: string, exe: string }}
 */
function stageHost({ dataDir, extId, name, tag }) {
  const exe = path.join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe')
  const nh = path.join(ROOT, 'electron', 'native-host.cjs')
  const cmd = path.join(dataDir, `${tag}-host.cmd`)
  const manifest = path.join(dataDir, `${tag}-manifest.json`)
  fs.mkdirSync(dataDir, { recursive: true })

  fs.writeFileSync(
    cmd,
    [
      '@echo off',
      'setlocal',
      'set ELECTRON_RUN_AS_NODE=1',
      `set HARBOR_DATA_ROOT=${dataDir}`,
      `"${exe}" "${nh}"`,
      '',
    ].join('\r\n'),
    'ascii',
  )
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      name,
      description: `Harbor ${tag} acceptance host`,
      path: cmd,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extId}/`],
    }),
  )
  regAdd(name, manifest)
  return { cmd, manifest, exe }
}

/**
 * ── ★ 注册表原值必须**外部备份**（2026-10-16 真机逮到的「假绿」）────────
 *
 * 这些脚本都写**同一个**注册表键（`com.harbor.agent`），做法是「开跑时读原值 →
 * 摘掉 → 装隔离 host → 跑完恢复原值」。问题是：**原值就是开跑时现读的那个**。
 *
 * 于是只要**上一轮没恢复成功**（脚本被杀 / 恢复段自己出错），这一轮读到的「原值」
 * 就已经是**隔离值**了 → 它「恢复」成隔离值 → 回读比对还**恒等一致** → 打印
 * 「✓ 与原值一致」。用户手工装的那条就这么被永久覆盖，而**看起来一切正常**。
 * （实测踩到：注册表停在 `p3c-manifest.json`，而 3c 报「20/20 + 一致」。）
 *
 * 所以把**第一次**读到的真原值记到 `tmp/` 下的备份文件里，之后每轮都以**它**为准；
 * 备份里若已经是个隔离值（`data/unit-test-data/` 下的），说明连备份都被污染过 ——
 * 那就以当前读到的为准（至少不会更糟），并**在返回值里标出来**让脚本可以报红。
 */
const BACKUP = path.join(ROOT, 'tmp', '.native-messaging-registry.json')
/** 隔离根的标记：值里出现它 = 不是用户的真值 */
const ISO_MARK = `${path.sep}unit-test-data${path.sep}`

function readBackup() {
  try {
    return JSON.parse(fs.readFileSync(BACKUP, 'utf8')) ?? {}
  } catch {
    return {}
  }
}

function writeBackup(name, value) {
  try {
    fs.mkdirSync(path.dirname(BACKUP), { recursive: true })
    fs.writeFileSync(BACKUP, JSON.stringify({ ...readBackup(), [name]: value }, null, 2))
  } catch {
    /* 写不进去不影响本轮（只是下次还得再记一遍） */
  }
}

/** 从 `reg QUERY` 的输出里抠出值（`REG_SZ    <值>`） */
function parseRegValue(stdout) {
  const m = String(stdout ?? '').match(/REG_SZ\s+(.+)/)
  return m ? m[1].trim() : ''
}

/**
 * 记下/取回**真原值**（模块顶层调一次）。
 *
 * @returns {{ value: string, polluted: boolean }} `polluted=true` 说明「现在注册表里
 *   是个隔离值，而备份里也没有更可信的值」—— 脚本该把这个报成警告。
 */
function snapshotRegistry(name) {
  const current = parseRegValue(spawnSync('reg', ['QUERY', `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${name}`, '/ve'], { encoding: 'utf8' }).stdout)
  const remembered = String(readBackup()[name] ?? '')
  const currentIsIso = current.includes(ISO_MARK)
  if (remembered && !remembered.includes(ISO_MARK)) return { value: remembered, polluted: false }
  if (current && !currentIsIso) {
    writeBackup(name, current)
    return { value: current, polluted: false }
  }
  /* 两边都不可信（备份也是隔离值 / 当前是隔离值）→ 如实说，并用当前这个 */
  if (current) writeBackup(name, current)
  return { value: current, polluted: currentIsIso }
}

/**
 * 恢复注册表到**真原值**，并回读比对。
 *
 * @returns {{ ok: boolean, actual: string, want: string }} `ok=false` = 恢复失败，
 *   脚本应把它算成失败（**别再无条件打印「已恢复」**—— 那正是当年骗过我的一处）。
 */
function restoreRegistry(name, value) {
  const want = String(value ?? '')
  if (!want) return { ok: false, actual: '', want: '' }
  regAdd(name, want)
  const actual = parseRegValue(spawnSync('reg', ['QUERY', `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${name}`, '/ve'], { encoding: 'utf8' }).stdout)
  return { ok: actual === want, actual, want }
}

/** 清掉一台隔离 host 留下的文件（注册表用 regDel） */
function unstageHost({ dataDir, tag }) {
  for (const f of [`${tag}-manifest.json`, `${tag}-host.cmd`]) {
    try {
      fs.rmSync(path.join(dataDir, f), { force: true })
    } catch {
      /* 忽略 */
    }
  }
}

module.exports = { ROOT, regAdd, regDel, stageHost, unstageHost, snapshotRegistry, restoreRegistry, parseRegValue }
