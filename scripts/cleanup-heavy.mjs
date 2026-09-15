/**
 * 清理开发/截图工具留下的重量级临时文件。
 * 不触碰 data/（用户配置、会话、记忆、技能和工作目录）。
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const removable = []
const releaseMode = process.argv.includes('--release')

for (const name of readdirSync(ROOT)) {
  if (name.startsWith('.chrome-profile')) removable.push(name)
}
for (const name of ['shots', 'shots-onboard']) removable.push(name)
if (releaseMode) removable.push('node_modules')

if (releaseMode) {
  console.log('发布清理模式：将删除 node_modules（便携版不依赖它，之后开发前需 npm install）')
}

for (const name of removable) {
  const target = join(ROOT, name)
  if (!existsSync(target)) continue
  rmSync(target, { recursive: true, force: true })
  console.log(`已清理：${name}`)
}

console.log(`完成。已保护：data/、dist-portable/、源码和 dist/。`)
