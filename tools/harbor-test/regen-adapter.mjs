import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const EXPECTED = {
  probe: '489511840786042014dd67198f0251fcb70325d19aeafeafe0e787ba30d85b9e',
  upstream: 'cec56e98ce9adcd6f8cf2fe3dcb7f6db3000a2c7d15bf3780227d34ea2779c4b',
}
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`重新生成探针隔离锚点异常（${label}：${count} 处），停止适配`)
  return source.replace(before, after)
}

export function stageRegenProbe({ sourceFile, upstreamFile, targetDir, repoRoot, electronExe, isolationDir, requestLog, appPort, fakePort }) {
  if (!Number.isInteger(appPort) || !Number.isInteger(fakePort) || appPort < 1024 || fakePort < 1024 || appPort + 15 > 65535 || fakePort > 65535 || appPort === fakePort) {
    throw new Error('重新生成探针端口无效或重复')
  }
  if (digest(sourceFile) !== EXPECTED.probe || digest(upstreamFile) !== EXPECTED.upstream) throw new Error('重新生成探针源文件哈希已变化，适配待复核')
  const source = readFileSync(sourceFile, 'utf8')
  let staged = source
  const replacements = [
    ["const ROOT = resolve(import.meta.dirname, '..', '..')", `const ROOT = ${JSON.stringify(repoRoot)}`, '源码根目录'],
    ["const BIN = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')", `const BIN = ${JSON.stringify(electronExe)}`, 'Electron 程序路径'],
    ["const ISO = resolve(ROOT, 'data', 'unit-test-data')", `const ISO = ${JSON.stringify(isolationDir)}`, '隔离数据根'],
    ["const PORT = 9391", `const PORT = ${appPort}`, 'Electron 调试端口'],
    ["const FAKE_PORT = 9981", `const FAKE_PORT = ${fakePort}`, '假上游端口'],
    ["const REQ_LOG = resolve(ROOT, 'tmp', 'edge', 'regen-requests.jsonl')", `const REQ_LOG = ${JSON.stringify(requestLog)}`, '请求记录路径'],
  ]
  for (const [before, after, label] of replacements) staged = replaceOnce(staged, before, after, label)
  const importAnchor = "import { connect, sleep, findPageTarget, evaluate } from '../../tools/shot/cdp.mjs'"
  const importedModule = pathToFileURL(join(repoRoot, 'tools', 'shot', 'cdp.mjs')).href
  staged = replaceOnce(staged, importAnchor, `import { connect, sleep, findPageTarget, evaluate } from ${JSON.stringify(importedModule)}`, 'CDP 模块路径')
  const upstreamAnchor = "resolve(import.meta.dirname, 'fake-regen-upstream.mjs')"
  staged = replaceOnce(staged, upstreamAnchor, JSON.stringify(join(targetDir, 'fake-regen-upstream.mjs')), '假上游路径')
  mkdirSync(targetDir, { recursive: true })
  const script = join(targetDir, 'accept-regen-real.mjs')
  const upstream = join(targetDir, 'fake-regen-upstream.mjs')
  mkdirSync(dirname(requestLog), { recursive: true })
  writeFileSync(script, staged, 'utf8')
  writeFileSync(upstream, readFileSync(upstreamFile, 'utf8'), 'utf8')
  return { script, upstream, appPort, fakePort, requestLog }
}
