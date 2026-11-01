// 只在验收子进程中生效；改运行资源地址，不改判据表达式。
const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const target = path.resolve(process.env.HARBOR_TEST_SCRIPT || '')
const profileRoot = process.env.HARBOR_TEST_PROFILE_ROOT
const hostExe = process.env.HARBOR_TEST_HOST_EXE
const portBase = Number(process.env.HARBOR_TEST_PORT_BASE)
const original = Module._extensions['.cjs'] || Module._extensions['.js']
Module._extensions['.cjs'] = function (mod, filename) {
  if (!profileRoot || !Number.isInteger(portBase) || portBase < 1024) return original(mod, filename)
  let source = fs.readFileSync(filename, 'utf8')
  const norm = path.resolve(filename)
  if (norm === target && process.env.HARBOR_TEST_INSTALLER_DIR && path.basename(filename) === 'accept-extension.cjs') {
    const replacements = [
      ["const DIST = path.join(BASE, 'dist', 'sidepanel')", `const DIST = ${JSON.stringify(path.join(process.env.HARBOR_TEST_INSTALLER_DIR, 'dist', 'sidepanel'))}`],
      ["const INSTALL = path.join(BASE, 'install-host.cmd')", `const INSTALL = ${JSON.stringify(path.join(process.env.HARBOR_TEST_INSTALLER_DIR, 'install-host.cmd'))}`],
      ["const UNINSTALL = path.join(BASE, 'uninstall-host.cmd')", `const UNINSTALL = ${JSON.stringify(path.join(process.env.HARBOR_TEST_INSTALLER_DIR, 'uninstall-host.cmd'))}`],
      ["const PROFILE = 'profile-1c2-accept'", `const PROFILE = 'profile-${process.env.HARBOR_TEST_ATTEMPT}'`],
    ]
    for (const [anchor, replacement] of replacements) {
      if (!source.includes(anchor)) throw new Error('accept-extension 隔离锚点已变化，拒绝使用原路径运行')
      source = source.replace(anchor, replacement)
    }
    const installCall = "if (runCmd(INSTALL) !== 0) throw new Error('install-host.cmd 失败')"
    if (!source.includes(installCall)) throw new Error('accept-extension 安装器调用已变化，拒绝未验证的 ID 注入')
    source = source.replace(installCall, "if (runCmd(INSTALL, [process.env.HARBOR_TEST_EXTENSION_ID, process.env.HARBOR_INSTALL_DIR]) !== 0) throw new Error('install-host.cmd 失败')")
  }
  if (norm === target || norm === path.resolve(__dirname, '../../harbor-edge/lib/ext-m02b-stage.cjs')) {
    const ports = [...source.matchAll(/\bconst ((?:[A-Z]+_)?PORT(?:_[A-Z]+)?) = (\d+)\b/g)]
    if (ports.length > 16) throw new Error('端口适配超出允许范围')
    ports.forEach((m, i) => { source = source.replace(m[0], `const ${m[1]} = ${portBase + i}`) })
    if (path.basename(filename) !== 'accept-extension.cjs') {
      source = source.replace(/\bconst PROFILE = '([^']+)'/, (_, name) => `const PROFILE = '${name}-${process.env.HARBOR_TEST_ATTEMPT}'`)
    }
    source = source.replace(/^const (STAGE|PROBE) = .*$/gm, (_, name) => `const ${name} = path.join(process.env.HARBOR_TEST_STAGE, '${name.toLowerCase()}')`)
    source = source.replaceAll("path.join(ROOT, 'harbor-edge', 'profiles', PROFILE)", 'path.join(D.PROFILE_ROOT, PROFILE)')
    if (hostExe) source = source.replaceAll("path.join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe')", JSON.stringify(hostExe))
  }
  if (norm === path.resolve(__dirname, '../../harbor-edge/lib/driver.cjs')) {
    const old = "const PROFILE_ROOT = path.join(BASE, 'profiles')"
    if (!source.includes(old)) throw new Error('Edge 驱动已变更，拒绝未验证的隔离适配')
    source = source.replace(old, `const PROFILE_ROOT = ${JSON.stringify(profileRoot)}`)
    source = source.replace('const REPORT_PORT = 8792', `const REPORT_PORT = ${portBase + 15}`)
    source = source.replace('function removeProfile(profile, attempts = 5) {', 'function removeProfile(profile, attempts = 5) { if (process.env.HARBOR_TEST_KEEP_PROFILE === "1") return false;')
  }
  if (hostExe && norm === path.resolve(__dirname, '../../harbor-edge/lib/ext-stage.cjs')) {
    const old = "const exe = path.join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe')"
    if (!source.includes(old)) throw new Error('Host 路径已变更，拒绝未验证的目标适配')
    source = source.replace(old, `const exe = ${JSON.stringify(hostExe)}`)
    const backup = "const BACKUP = path.join(ROOT, 'tmp', '.native-messaging-registry.json')"
    if (!source.includes(backup)) throw new Error('注册表备份路径已变更，拒绝未验证的隔离适配')
    source = source.replace(backup, `const BACKUP = ${JSON.stringify(process.env.HARBOR_TEST_REG_BACKUP)}`)
  }
  mod._compile(source, filename)
}
