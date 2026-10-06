/* 建/复用 GitHub Release 并上传 zip（没有 gh CLI，走 curl.exe + 本地代理）
 *
 * 为什么不用 fetch：实测直连 api.github.com 会 ECONNRESET（2026-09-29，见 tmp/README.md），
 * 必须走本机代理（10808；git config 里那个 10809 是死的）。
 *
 * token 从 `git credential fill` 取，只留在内存里，**绝不打印**。
 *
 * 跑法：node tmp/mk-release.mjs           # 建 release + 传 zip（幂等：重复跑不会建第二个）
 *       node tmp/mk-release.mjs --dry     # 只报告现状，不发任何写请求
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const REPO = 'KhooTsuen/harbor-agent'
const PROXY = 'http://127.0.0.1:10808'
const API = `https://api.github.com/repos/${REPO}`
const DRY = process.argv.includes('--dry')

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const tag = `v${version}`
const zipPath = join(ROOT, 'dist-portable', `harbor-${version}-win-x64.zip`)
const bodyPath = join(ROOT, 'tmp', 'release-body.md')

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\n\n',
  })
  const m = /^password=(.+)$/m.exec(out)
  if (!m) throw new Error('git credential 里拿不到 password（token）')
  return m[1].trim()
}

const auth = token()
const curl = (args) =>
  spawnSync('curl.exe', ['-sS', '--max-time', '900', '-x', PROXY, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

/** 带状态码的请求：返回 { code, json, raw }（token 只在 header 里，不进日志） */
function call(method, url, extra = []) {
  const r = curl(['-X', method, '-H', `Authorization: Bearer ${auth}`, ...extra, '-w', '\n%{http_code}', url])
  const text = r.stdout ?? ''
  const at = text.lastIndexOf('\n')
  const code = Number(text.slice(at + 1).trim())
  const payload = text.slice(0, at)
  let json = null
  try {
    json = JSON.parse(payload)
  } catch {
    /* 非 JSON（例如限流）就留 null */
  }
  return { code, json, raw: payload.slice(0, 300) }
}

const zipName = `harbor-${version}-win-x64.zip`
console.log(
  `仓库 ${REPO}｜tag ${tag}｜zip ${existsSync(zipPath) ? `${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB` : '（不存在！）'}`,
)

/* 1. 已经发过了吗（幂等） */
const found = call('GET', `${API}/releases/tags/${tag}`)
let releaseId = null
if (found.code === 200 && found.json) {
  releaseId = found.json.id
  console.log(`已存在 release：id=${releaseId}`)
  console.log(`  ${found.json.html_url}`)
  const assets = (found.json.assets ?? []).map((a) => `${a.name} (${(a.size / 1024 / 1024).toFixed(1)} MB)`)
  console.log(`  已有资产：${assets.length ? assets.join('、') : '（无）'}`)
  if (assets.some((s) => s.startsWith(`${zipName} `))) {
    console.log('  资产已存在，什么都不做')
    process.exit(0)
  }
}

if (DRY) {
  console.log(releaseId ? '（--dry）release 已存在，缺资产' : `（--dry）会把 release 建在 tag ${tag} 上`)
  process.exit(0)
}

/* 2. 没有就建（payload 落文件，避开 shell 引号） */
if (!releaseId) {
  const payload = join(ROOT, 'tmp', 'release-payload.json')
  writeFileSync(
    payload,
    JSON.stringify(
      { tag_name: tag, name: tag, body: readFileSync(bodyPath, 'utf8'), draft: false, prerelease: false },
      null,
      2,
    ),
    'utf8',
  )
  const created = call('POST', `${API}/releases`, [
    '-H',
    'Content-Type: application/json',
    '--data-binary',
    `@${payload}`,
  ])
  if (created.code !== 201) {
    console.error(`建 release 失败：HTTP ${created.code}\n${created.raw}`)
    process.exit(1)
  }
  releaseId = created.json.id
  console.log(`✓ release 已建：id=${releaseId}`)
  console.log(`  ${created.json.html_url}`)
}

/* 3. 传 zip（走 uploads 域名；147MB 过代理要一会儿） */
if (!existsSync(zipPath)) {
  console.error('zip 不存在，先 npm run release:zip')
  process.exit(1)
}
const up = call('POST', `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${zipName}`, [
  '-H',
  'Content-Type: application/zip',
  '--data-binary',
  `@${zipPath}`,
])
if (up.code !== 201) {
  console.error(`传资产失败：HTTP ${up.code}\n${up.raw}`)
  process.exit(1)
}
console.log(`✓ 资产已传：${up.json.name} ${(up.json.size / 1024 / 1024).toFixed(1)} MB`)
console.log(`  ${up.json.browser_download_url}`)
