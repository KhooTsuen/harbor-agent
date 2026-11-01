import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
export const INSTALLED = 'E:\\Harbor'

const ids = [
  'accept-sidepanel.cjs', 'accept-extension.cjs', 'accept-host.cjs',
  'accept-phase2.cjs', 'accept-phase3a.cjs', 'accept-phase3b.cjs', 'accept-phase3c.cjs',
  'accept-m02a.cjs', 'accept-m02b.cjs', 'accept-m03.cjs',
  'accept-m04a.cjs', 'accept-m04b.cjs', 'accept-m04c.cjs', 'accept-m04d.cjs', 'accept-m04f.cjs',
  'accept-ownership.cjs', 'accept-regen-real.mjs', 'accept-toolbar-entry.cjs',
]

export const e2eScripts = ids.map((name) => ({
  id: name.replace(/\.\w+$/, ''),
  file: join(ROOT, 'harbor-edge', 'tools', name),
  manual: name === 'accept-toolbar-entry.cjs',
  externalHost: name === 'accept-host.cjs',
  legacy: name === 'accept-sidepanel.cjs',
  edge: name !== 'accept-regen-real.mjs',
}))

export function targetInfo(kind, installedPath = INSTALLED) {
  if (kind === 'source') return { kind, path: ROOT, id: `source:${ROOT.toLowerCase()}` }
  if (kind !== 'installed') throw new Error(`未知目标：${kind}`)
  const file = join(installedPath, 'Harbor.exe')
  if (!existsSync(file)) throw new Error(`找不到安装版程序：${file}`)
  const pkg = join(installedPath, 'resources', 'app', 'package.json')
  let version = 'unknown'
  try { version = JSON.parse(readFileSync(pkg, 'utf8')).version ?? version } catch { /* 报告会保留 unknown */ }
  return { kind, path: installedPath, id: `installed:${installedPath.toLowerCase()}`, version }
}

export const verifyStages = [
  'typecheck', 'lint', 'lint:kernel', 'typecheck:kernel', 'check:format', 'check:lines',
  'check:rules', 'test:rules', 'test:unit', 'test', 'security', 'build',
]
