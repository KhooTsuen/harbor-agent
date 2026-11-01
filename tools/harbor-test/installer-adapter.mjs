import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const EXPECTED = {
  'tools/accept-extension.cjs': '2d8e9c738f39d77037e538f2110863bafd22ed962fcabc09ce6b77f3884eaac4',
  'install-host.cmd': 'c71ad88ac7a0bcd2ce21467da5a4a51a5546f9c0f03ac8cedc4b6785af0608df',
  'uninstall-host.cmd': '4b9d34404787bd6839c47461fcaa1268028dbd7d0d1d4c0c23c6aef4a3416df1',
  'harbor-host.cmd': 'beb043bedfd5f772664a7b1efe66720b652ff6ab745b47149b7a7a49d2340b7e',
  'tools/read-extid.cjs': 'd86aaeed95ccbd7f50812dfcfe5a3cc67e6556ec6f67bd7ff5fdeba9e15ed7ce',
  'lib/driver.cjs': 'f4858453af1e1087c502e6ec41ddec7ce64e2138de4d9c3336f921c67aa2cf29',
}

const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function checkedText(file, relative, anchor) {
  const text = readFileSync(file, 'utf8')
  if (!text.includes(anchor)) throw new Error(`${relative} 的隔离适配锚点已变化，停止运行`)
  return text
}

export function installerWorkspace(runDir) {
  return join(runDir, 'installer-workspace')
}

export function stageInstaller(root, target, portBase) {
  const source = join(root, 'harbor-edge')
  for (const [relative, expected] of Object.entries(EXPECTED)) {
    if (digest(join(source, ...relative.split('/'))) !== expected) throw new Error(`${relative} 源文件哈希已变化，适配待复核`)
  }
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase + 15 > 65535) throw new Error('安装器隔离端口范围无效')
  mkdirSync(target, { recursive: true })
  for (const name of ['install-host.cmd', 'uninstall-host.cmd', 'harbor-host.cmd', 'tools', 'lib', 'dist']) {
    const from = join(source, name)
    if (!existsSync(from)) throw new Error(`安装器测试文件不存在：${from}`)
    cpSync(from, join(target, name), { recursive: true })
  }
  const probe = join(target, 'tools', 'read-extid.cjs')
  let probeText = checkedText(probe, 'tools/read-extid.cjs', "const basePort = Number(arg('port', '9460'))")
  probeText = probeText.replace('profile-extid-${i}', 'profile-${process.env.HARBOR_TEST_ATTEMPT}-extid-${i}')
  const launchAnchor = 'D.launchEdge(extDir ? { profileName, port, extDir } : { profileName, port })'
  if (!probeText.includes(launchAnchor)) throw new Error('tools/read-extid.cjs 的 Edge 启动锚点已变化，停止适配')
  probeText = probeText.replace(launchAnchor, 'D.launchEdge(extDir ? { profileName, port, extDir, waitMs: 10000 } : { profileName, port, waitMs: 10000 })')
  probeText = probeText.replace("const basePort = Number(arg('port', '9460'))", "const basePort = Number(arg('port', process.env.HARBOR_TEST_EXTID_PORT ?? '9460'))")
  writeFileSync(probe, probeText, 'utf8')
  const driver = join(target, 'lib', 'driver.cjs')
  let driverText = checkedText(driver, 'lib/driver.cjs', 'function removeProfile(profile, attempts = 5) {')
  driverText = checkedText(driver, 'lib/driver.cjs', "const PROFILE_ROOT = path.join(BASE, 'profiles')")
  driverText = driverText.replace("const PROFILE_ROOT = path.join(BASE, 'profiles')", `const PROFILE_ROOT = ${JSON.stringify(join(target, '..', 'installer-edge-profiles'))}`)
  driverText = driverText.replace('const REPORT_PORT = 8792', `const REPORT_PORT = ${portBase + 15}`)
  driverText = driverText.replace('function removeProfile(profile, attempts = 5) {', 'function removeProfile(profile, attempts = 5) { if (process.env.HARBOR_TEST_KEEP_PROFILE === "1") return false;')
  writeFileSync(driver, driverText, 'utf8')
  const installer = join(target, 'install-host.cmd')
  const installerText = checkedText(installer, 'install-host.cmd', 'set "EXT_ID=%~1"')
  writeFileSync(installer, installerText.replace('set "EXT_ID=%~1"', 'set "EXT_ID=%HARBOR_TEST_EXTENSION_ID%"'), 'utf8')
  return target
}
