import { readdirSync } from 'node:fs'
import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   问题 18：外链白名单（`electron/core/url-policy.cjs`）

   以前 `main.cjs` 的 `setWindowOpenHandler` 是 `shell.openExternal(url)` 直接开：
   聊天里一条 `[点我](file:///C:/Windows/system.ini)` 渲染成 `<a target="_blank">`，
   点一下系统就**打开本地文件**。

   这一组钉三件事：
     ① 判据本身（放行三种协议，其余一律拒绝）
     ② **行为**：不在白名单里，`shell.openExternal` 一次都不能被调用
        （「先开再拦」不算拦）
     ③ **只有一处**：核心里除了 url-policy，谁都不许再直接 `.openExternal(`
        —— 判据写在两处就一定漂，一处加了另一处忘，洞还在
   ══════════════════════════════════════════════════════════════ */

/** 假的 shell：真 shell 一调用就会弹出用户的浏览器 */
function fakeShell() {
  const opened = []
  return { opened, openExternal: (url) => void opened.push(url) }
}

export async function run() {
  const policy = require(join(ROOT, 'electron/core/url-policy.cjs'))

  group('问题 18 / 外链白名单')

  check(
    '导出形状没变（少一个就当场红，不让它把整组带崩）',
    typeof policy.isOpenableExternal === 'function' &&
      typeof policy.openExternalSafe === 'function' &&
      Array.isArray(policy.ALLOWED_SCHEMES),
  )
  check(
    '只放行三种协议',
    JSON.stringify(policy.ALLOWED_SCHEMES) === JSON.stringify(['http:', 'https:', 'mailto:']),
    policy.ALLOWED_SCHEMES.join(' '),
  )

  check(
    '★ 放行 http / https / mailto（大小写与首尾空格不影响）',
    ['http://example.com', 'https://example.com/a/b?c=1', 'HTTPS://Example.com', '  https://e.com ', 'mailto:a@b.c'].every(
      (u) => policy.isOpenableExternal(u),
    ),
  )
  check(
    '★ 拒绝 file:///C:/Windows/system.ini（本批的正题）',
    !policy.isOpenableExternal('file:///C:/Windows/system.ini') &&
      !policy.isOpenableExternal('file:///etc/passwd'),
  )
  check(
    '★ 拒绝脚本 / 数据 / 系统设置类协议',
    [
      'javascript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'ms-settings:privacy',
      'blob:https://example.com/x',
      'about:blank',
      'chrome://settings',
      'shell:startup',
    ].every((u) => !policy.isOpenableExternal(u)),
  )
  check(
    '空值与非字符串也当拒绝（拿不到协议 = 不允许）',
    ['', '   ', 'example.com', undefined, null, 42, {}, []].every(
      (raw) => !policy.isOpenableExternal(raw) && policy.schemeOf(raw) === '',
    ),
  )

  const allowed = fakeShell()
  check(
    '★ 行为：白名单内才真的交给系统，而且原样传（不改写地址）',
    policy.openExternalSafe(allowed, 'https://example.com/x', 'selftest') === true &&
      allowed.opened.join(',') === 'https://example.com/x',
    allowed.opened.join(','),
  )

  const denied = fakeShell()
  const deniedOk =
    policy.openExternalSafe(denied, 'file:///C:/Windows/system.ini', 'selftest') === false &&
    policy.openExternalSafe(denied, 'javascript:alert(1)', 'selftest') === false
  check(
    '★ 行为：不在白名单里**一次都不调用**（不是「先开再拦」）',
    deniedOk && denied.opened.length === 0,
    denied.opened.join(','),
  )

  const throwing = {
    openExternal: () => {
      throw new Error('boom')
    },
  }
  check(
    'shell 不可用 / 抛错都不往外冒（点链接不能把主进程弄挂）',
    policy.openExternalSafe(null, 'https://example.com', 'selftest') === false &&
      policy.openExternalSafe(throwing, 'https://example.com', 'selftest') === false,
  )

  /*
   * 留痕的**文案**是跨模块判据：真机探针（`tmp/b5-machine-probe.cjs`）按这两句话
   * 判断「交出去了」还是「被拦了」，改字要同步改它。所以这里真读日志文件断言，
   * 不是抠源码字符串。
   */
  const log = require(join(ROOT, 'electron/core/log.cjs'))
  const { DIRS } = require(join(ROOT, 'electron/core/paths.cjs'))
  const logPath = join(DIRS.logs, `${log.dayStamp()}.log`)
  const logText = readFileSync(logPath, 'utf8')
  check(
    '★ 拒绝时真的在日志里留痕（真机探针按这句话认，改字要同步改探针）',
    /拒绝打开外部链接 \[selftest\][^\n]*拿到的是 file:/.test(logText),
  )
  check(
    '★ 成功时也留一笔（「点链接没反应」时能分清是交出去了还是被拦了）',
    /打开外部链接 \[selftest\][^\n]*example\.com/.test(logText),
  )

  /* 唯一一处：`.openExternal(` 只该出现在 url-policy 里面 */
  const kernelFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name)
      if (e.isDirectory()) return e.name === 'chromium' ? [] : kernelFiles(full)
      return e.name.endsWith('.cjs') ? [full] : []
    })
  const callers = kernelFiles(join(ROOT, 'electron')).filter((f) =>
    /\.openExternal\(/.test(readFileSync(f, 'utf8')),
  )
  check(
    '★ 「外抛给系统」在核心里只有唯一一处（判据写在两处一定会漂）',
    callers.length === 1 && callers[0].endsWith('url-policy.cjs'),
    callers.map((f) => f.slice(f.lastIndexOf('electron'))).join(', ') || '（一处都没有？）',
  )
}
