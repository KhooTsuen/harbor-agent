import { check, group } from '../harness.mjs'
import { ROOT, join, readFileSync } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   浏览器的「等待时间账」

   2026-09-28 真机故障的根因：主进程等渲染层回话 45 秒
   （`electron/handlers/browser.cjs` 的 REQUEST_TIMEOUT_MS），
   而渲染层原来是**三段各自独立**的等待 —— 等元素 12s + 等 dom-ready 15s
   + 等加载 20s + 给 SPA 的 1.2s ≈ 48 秒。相加超过了主进程的耐心，
   于是慢页面一律被判成「界面没有在 45 秒内回应（浏览器标签可能被关了）」，
   而真相是界面正在读。用户看到的是「AI 说读不到网页，我点一下它又能读了」。
   （日志证据见 `E:\Harbor\data\logs\2026-09-28.log` 里那一串同样的 WARN。）

   这一组全是**源码钉子**（真跑要开 Electron + 真网页，不适合放自检里）：
   最要紧的一条是把两个数字分别从两个文件里读出来**比大小** ——
   以后谁把预算调过头、或把主进程的等待改小，都会当场红。
   ══════════════════════════════════════════════════════════════ */

/** 从源码里抠一个形如 `NAME = 12_345` 的数字常量 */
function numberConst(src, name) {
  const raw = src.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`))?.[1] ?? ''
  return Number(raw.replace(/_/g, '')) || 0
}

export async function run() {
  const waitSrc = readFileSync(join(ROOT, 'src/components/layout/browser/browseWait.ts'), 'utf8')
  const driverSrc = readFileSync(
    join(ROOT, 'src/components/layout/browser/useBrowseDriver.ts'),
    'utf8',
  )
  const handlerSrc = readFileSync(join(ROOT, 'electron/handlers/browser.cjs'), 'utf8')
  const readSrc = readFileSync(join(ROOT, 'electron/core/browse-read.cjs'), 'utf8')
  const scriptsSrc = readFileSync(join(ROOT, 'src/components/layout/browser/scripts.ts'), 'utf8')

  group('浏览器 / 等待的时间账')

  const rendererMs = numberConst(waitSrc, 'BROWSE_BUDGET_MS')
  const mainMs = numberConst(handlerSrc, 'REQUEST_TIMEOUT_MS')
  check(
    '★ 渲染层总预算 < 主进程等待（不然慢页面必然误报「界面没回应」）',
    rendererMs > 0 && mainMs > 0 && rendererMs < mainMs,
    `渲染层 ${rendererMs}ms vs 主进程 ${mainMs}ms`,
  )
  const readMs = numberConst(handlerSrc, 'READ_TIMEOUT_MS')
  check(
    '★ 主进程读正文有独立上限，且 < 等界面上限（页面卡死时兜得住）',
    readMs > 0 && readMs < mainMs,
    `读 ${readMs}ms vs 等界面 ${mainMs}ms`,
  )
  check(
    '★ 等待共用同一条预算（不是各等各的）',
    driverSrc.includes('new Budget()') &&
      /waitForElement\(\(\) => webviewRef\.current, budget\)/.test(driverSrc) &&
      /waitForLoad\(view, budget\)/.test(driverSrc),
  )
  check(
    '★ B2：读正文搬到主进程（渲染层只报 ready + webContentsId）',
    driverSrc.includes('ready: true') &&
      driverSrc.includes('webContentsId') &&
      !driverSrc.includes('READ_SCRIPT'),
  )
  check(
    '★ 读正文脚本只有一处（渲染层的同名导出已删）',
    readSrc.includes('READ_SCRIPT') && !scriptsSrc.includes('READ_SCRIPT'),
  )
  check(
    '★ guest 没就绪时执行脚本会重试（真机见过 Script failed to execute）',
    waitSrc.includes('GUEST_VIEW_MANAGER_CALL') &&
      /waitForDomReady\(view, budget\)/.test(waitSrc) &&
      waitSrc.includes('tries'),
  )
  check(
    '★ 超时由渲染层自己说清原因（不让主进程用猜的）',
    driverSrc.includes('等页面就绪超时') && driverSrc.includes('budget.expired'),
  )
  check(
    '★ 空正文会再读几次（SPA 加载完才填内容）—— 现在在主进程',
    readSrc.includes('填内容') && /attempt === tries/.test(readSrc),
  )
  /* 主进程那句误导人的话还在（它是兜底），但渲染层必须能先回话 */
  check(
    '主进程的超时兜底仍然保留',
    handlerSrc.includes('界面没有在 45 秒内回应'),
  )
}
