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

module.exports = { ROOT, regAdd, regDel, stageHost, unstageHost }
