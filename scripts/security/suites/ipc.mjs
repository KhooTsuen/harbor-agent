/**
 * security:ipc —— Electron 渲染与 IPC 安全（SEC-001 ~ 012）
 *
 * 归属本套件的：001 / 002 / 003 / 004 / 007 / 009 / 011 / 012
 * （005 / 006 / 008 / 010 在 `static` —— 它们静态可判，那边一次做完）。
 *
 * 001~004 是**渲染层**的事，必须在 jsdom + 真渲染器里跑 —— 用源码字符串判
 * 「有没有危险标签」是清单第 0 节明令禁止的。它们由
 * `src/lib/__tests__/securityHtml.test.tsx` 承载，本套件用 vitest 真跑它、
 * 按 `it('SEC-00X …')` 逐条读回结果（`runRender`）。
 */

import { CASES } from '../cases.mjs'
import { mark, sec } from '../harness.mjs'
import { fs, path, ROOT, WORKSPACE } from '../sandbox.mjs'
import { execFileSync } from 'node:child_process'

const join = path.join
const RENDER_TEST = join(ROOT, 'src/lib/__tests__/securityHtml.test.tsx')
const RENDER_IDS = ['SEC-001', 'SEC-002', 'SEC-003', 'SEC-004']

/**
 * 真跑 vitest，把 `it('SEC-00X …')` 的逐条结果读回来。
 * 用 json reporter 精确到 case，而不是「整个文件过了就算过」——
 * 后者会让一个 case 的失败被另一个的通过盖住。
 */
function runRender() {
  if (!fs.existsSync(RENDER_TEST)) {
    for (const id of RENDER_IDS) mark(id, 'BLOCKED', '渲染层用例文件不存在')
    return
  }
  const out = join(ROOT, 'data', 'security-data', 'render-results.json')
  try {
    execFileSync('npx', ['vitest', 'run', RENDER_TEST, '--reporter=json', `--outputFile=${out}`], {
      cwd: ROOT,
      stdio: 'ignore',
      shell: true,
      timeout: 240000,
    })
  } catch {
    /* 有失败时 vitest 退出码非零 —— 结果文件仍然会写出来，下面照读 */
  }
  let payload = null
  try {
    payload = JSON.parse(fs.readFileSync(out, 'utf8'))
  } catch {
    payload = null
  }
  if (!payload) {
    for (const id of RENDER_IDS) mark(id, 'BLOCKED', 'vitest 未产出结果（环境问题，非通过）')
    return
  }
  const assertions = (payload.testResults ?? []).flatMap((f) => f.assertionResults ?? [])
  for (const id of RENDER_IDS) {
    const hits = assertions.filter((a) => String(a.fullName ?? a.title ?? '').includes(id))
    if (hits.length === 0) {
      mark(id, 'NOT_RUN', '渲染层用例里找不到该编号')
      continue
    }
    const bad = hits.filter((a) => a.status !== 'passed')
    if (bad.length) mark(id, 'FAIL', bad.map((a) => a.title).join('；'))
    else mark(id, 'PASS', `${hits.length} 条渲染层断言通过`, [path.relative(ROOT, RENDER_TEST)])
  }
}

/**
 * SEC-002 加强：默认配置下不可信内容不该执行脚本（清单第 1 节）。
 * 渲染层有一条 HTML 直通（`RawHtml.tsx`，2026-10-08 用户主动要求打开）——
 * 直通开启时 `onerror` 会执行。这里如实断言「默认必须关闭」，交由用户决定。
 */
function rawHtmlDefault() {
  const raw = fs.readFileSync(join(ROOT, 'src/components/chat/markdown/RawHtml.tsx'), 'utf8')
  const enabled = /const DEFAULT_ENABLED = true/.test(raw)
  sec('SEC-002', !enabled,
    `默认不开启 HTML 直通（当前 DEFAULT_ENABLED=${enabled ? 'true（onerror 会执行）' : 'false'}；见 RawHtml.tsx 文件头）`)
}

/** SEC-007：IPC sender 来源校验 */
function senderCheck() {
  const root = join(ROOT, 'electron')
  const hits = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.cjs')) {
        const text = fs.readFileSync(p, 'utf8')
        if (/senderFrame|validateSender|isTrustedSender/.test(text)) hits.push(path.relative(ROOT, p))
      }
    }
  }
  walk(root)
  sec('SEC-007', hits.length > 0,
    `主进程有 sender 来源校验（命中文件：${hits.join(', ') || '无'}。当前只有主窗口带 preload，webview 无 preload，属纵深缺失）`)
}

export async function run() {
  console.log('\n· SEC-001~004 渲染层 XSS（vitest 真跑）')
  runRender()
  rawHtmlDefault()
  console.log('\n· SEC-007 IPC sender 校验')
  senderCheck()
  console.log('\n· SEC-009 / 011 / 012')
  for (const c of CASES.filter((c) => ['SEC-009', 'SEC-011', 'SEC-012'].includes(c.id))) {
    mark(c.id, 'NOT_RUN', '待实现（下一批）')
  }
  void WORKSPACE
}
