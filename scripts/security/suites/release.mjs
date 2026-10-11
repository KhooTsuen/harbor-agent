/**
 * security:release —— 依赖 / 构建 / 发布供应链（SEC-077 ~ 084）
 *
 * 复用现有门禁脚本（check-rules）+ npm audit + 平台命令，不新建一套。
 */

import { sec, mark } from '../harness.mjs'
import { fs, path, require, ROOT } from '../sandbox.mjs'
import { spawnSync } from 'node:child_process'

const join = path.join

/** SEC-077：生产依赖已知严重漏洞阻止发布 */
function dependencyVulns() {
  const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 90000 })
  let meta = null
  try {
    meta = JSON.parse(r.stdout ?? '').metadata
  } catch {
    meta = null
  }
  if (!meta) {
    mark('SEC-077', 'BLOCKED', 'npm audit 无输出（离线 / 镜像不可达），未验证')
    return
  }
  const v = meta.vulnerabilities ?? {}
  sec('SEC-077', Number(v.critical ?? 0) === 0, `生产依赖无 critical（critical=${v.critical ?? 0}）`)
  sec('SEC-077', Number(v.high ?? 0) === 0, `生产依赖无 high（high=${v.high ?? 0}，见报告发现）`)
}

/** SEC-078：发布产物 / 仓库不混入真实密钥（只认 check-rules 的密钥扫描一项，与其它规则解耦） */
function noSecretsInRepo() {
  const r = spawnSync(process.execPath, ['scripts/check-rules.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 })
  const out = String(r.stdout ?? '')
  const line = out.split('\n').find((l) => l.includes('无明文密钥')) ?? ''
  sec('SEC-078', line.includes('✓'), `check-rules 的密钥扫描通过（${line.trim().slice(0, 42) || '未找到该检查项'}）`)
  sec('SEC-078', !fs.existsSync(join(ROOT, '.env')), '仓库里没有 .env（只有 .env.example）')
}

/** SEC-079：锁文件一致性 */
function lockfile() {
  const lock = join(ROOT, 'package-lock.json')
  sec('SEC-079', fs.existsSync(lock), '存在 package-lock.json（CI 用锁定安装）')
  let version = 0
  try {
    version = JSON.parse(fs.readFileSync(lock, 'utf8')).lockfileVersion ?? 0
  } catch {
    version = 0
  }
  sec('SEC-079', version >= 2, `锁文件版本可追溯（lockfileVersion=${version}）`)
}

/** SEC-080：构建后的实际 Electron 安全配置与源码一致（**开发面 + 生产面分别查**） */
function buildSecurityParity() {
  /* ── ① 渲染层生产构建（vite build 的 dist/）── */
  const index = join(ROOT, 'dist', 'index.html')
  if (!fs.existsSync(index)) {
    mark('SEC-080', 'BLOCKED', 'dist/index.html 不存在（还没构建），无法核对构建产物')
    return
  }
  const html = fs.readFileSync(index, 'utf8')
  sec('SEC-080', /Content-Security-Policy/.test(html), '构建产物注入了 CSP（源码安全策略随构建生效）')
  sec('SEC-080', /script-src 'self'/.test(html), '构建产物 CSP 禁内联脚本')

  /* ── ② 开发构建（源码）：主进程 + webview 的沙箱三项 ── */
  const three = (s) =>
    /contextIsolation: true/.test(s) && /nodeIntegration: false/.test(s) && /sandbox: true/.test(s)
  const mainSrc = fs.readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf8')
  sec('SEC-080', three(mainSrc), '开发构建：主窗口 contextIsolation/nodeIntegration/sandbox 三项齐')
  const browserTab = fs.readFileSync(join(ROOT, 'src', 'components', 'layout', 'BrowserTab.tsx'), 'utf8')
  sec(
    'SEC-080',
    /sandbox=yes/.test(browserTab) && /nodeIntegration=no/.test(browserTab),
    '开发构建：webview webpreferences 写死沙箱',
  )

  /* ── ③ 生产构建（dist-portable 打包产物）：与源码一致 ── */
  const packagedApp = join(ROOT, 'dist-portable', 'Harbor', 'resources', 'app')
  const packagedMain = join(packagedApp, 'electron', 'main.cjs')
  if (fs.existsSync(packagedMain)) {
    sec(
      'SEC-080',
      three(fs.readFileSync(packagedMain, 'utf8')),
      '生产构建（dist-portable）：产物主进程沙箱三项与源码一致',
    )
    sec(
      'SEC-080',
      fs.existsSync(join(packagedApp, 'electron', 'preload.cjs')),
      '生产构建：桥接层 preload.cjs 随产物一起打包（少了 IPC 全死）',
    )
  } else {
    /*
     * 没打包时**不假装测过产物**：改为核对「打包脚本把 electron/ 整目录原样拷进产物」
     * —— 这条一旦断，产物里的安全配置就和源码脱钩。真实产物核对在 `npm run package`
     * 之后由本套件自动接管（dist-portable 在就走上一个分支）。
     */
    const builder = fs.readFileSync(join(ROOT, 'scripts', 'build-portable.mjs'), 'utf8')
    const copiesWhole =
      /cpSync\(\s*join\(ROOT, 'electron'\),\s*join\(APP_OUT, 'electron'\)/.test(builder) ||
      builder.includes("cpSync(join(ROOT, 'electron'), join(APP_OUT, 'electron')")
    sec(
      'SEC-080',
      copiesWhole,
      '未打包：以「构建脚本整目录原样拷 electron/」为据（打包后本套件改测真实产物）',
    )
  }
}

/** SEC-081：更新包来源 / 完整性 —— 本项目无自动更新 */
function updatePolicy() {
  const pkg = JSON.parse(fs.readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const names = Object.keys(pkg.dependencies ?? {})
  const hasUpdater = names.some((n) => /electron-updater|auto-update/i.test(n))
  sec('SEC-081', !hasUpdater, '没有引入自动更新依赖（无更新包 → 该项不适用）')
  mark('SEC-081', 'NOT_APPLICABLE', '本项目不含自动更新机制（无更新包来源/签名需要校验）')
}

/** SEC-082：生产构建调试能力符合发布策略 */
function debugPolicy() {
  const main = fs.readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf8')
  const devGated = /if \(DEV_URL\)[\s\S]{0,200}openDevTools/.test(main)
  sec('SEC-082', devGated, 'DevTools 只在 DEV_URL（开发）分支里打开，打包版不开')
  sec('SEC-082', !/--remote-debugging-port/.test(main), '主进程不默认开启远程调试端口（只能由命令行显式传）')
}

/** SEC-083：SBOM / 依赖清单可生成 */
function sbom() {
  const r = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 60000 })
  const lines = String(r.stdout ?? '').split(/\r?\n/).filter(Boolean)
  sec('SEC-083', lines.length >= 1, `可生成生产依赖清单（${lines.length} 条）`)
}

/** SEC-084：安全审计日志 —— 关联构建版本、不记敏感数据 */
function auditLog() {
  const audit = require(join(ROOT, 'electron/core/audit.cjs'))
  const redact = require(join(ROOT, 'electron/core/redact.cjs'))
  const sentinel = 'sk-AUDIT084CANARY0123456789abcdefghij'
  redact.remember(sentinel, 'canary-084')
  try {
    audit.record({ tool: 'sec-test', ok: true, result: `输出含 ${sentinel}` })
  } catch {
    /* 记不上不影响 */
  }
  const entries = audit.read({ days: 1 })
  const blob = JSON.stringify(entries)
  sec('SEC-084', !blob.includes(sentinel), '审计日志里的敏感内容被脱敏')
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  sec('SEC-084', /^[0-9a-f]{7,40}/.test(String(head.stdout ?? '').trim()), '能取到构建版本（git commit）用于关联')
}

export async function run() {
  const steps = [
    ['SEC-077 生产依赖已知严重漏洞', () => dependencyVulns()],
    ['SEC-078 发布产物混入密钥 / 本地数据', () => noSecretsInRepo()],
    ['SEC-079 锁文件一致性', () => lockfile()],
    ['SEC-080 Electron 安全配置回归', () => buildSecurityParity()],
    ['SEC-081 更新包来源 / 完整性', () => updatePolicy()],
    ['SEC-082 生产构建调试能力', () => debugPolicy()],
    ['SEC-083 SBOM / 依赖清单', () => sbom()],
    ['SEC-084 安全审计日志', () => auditLog()],
  ]
  for (const [label, fn] of steps) {
    console.log(`\n· ${label}`)
    try {
      await fn()
    } catch (error) {
      sec(label.slice(0, 7), false, `套件抛错：${error instanceof Error ? error.message : error}`)
    }
  }
}
