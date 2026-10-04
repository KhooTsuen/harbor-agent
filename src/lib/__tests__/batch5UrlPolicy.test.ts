import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSafeHref } from '@/lib/linkPolicy'

/* ══════════════════════════════════════════════════════════════
   第 5 批：外链白名单（审计问题 18）

   以前 `main.cjs` 的 `setWindowOpenHandler` 直接 `shell.openExternal(url)`，
   而聊天里的 `[点我](file:///C:/Windows/system.ini)` 会渲染成 `<a target="_blank">`
   —— 点一下就**打开本地文件**。现在两道判据：

     · 渲染层 `src/lib/linkPolicy.ts`  —— 决定「画不画成链接」
     · 主进程 `electron/core/url-policy.cjs` —— 决定「开不开」（真正的边界）

   跨进程没法共用一个模块，所以这里额外钉一条**两边口径不能打架**：
   渲染层放行的绝对地址，主进程必须也放行（不然画出来的链接点了没反应）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)

const policy = require_(join(ROOT, 'electron/core/url-policy.cjs')) as {
  ALLOWED_SCHEMES: string[]
  schemeOf: (raw: unknown) => string
  isOpenableExternal: (raw: unknown) => boolean
  openExternalSafe: (
    shell: { openExternal?: (url: string) => unknown } | null,
    raw: unknown,
    where?: string,
  ) => boolean
}

/** 假的 shell：记下被打开过什么（真 shell 一调用就会弹出用户的浏览器） */
function fakeShell(): { opened: string[]; openExternal: (url: string) => void } {
  const opened: string[] = []
  return { opened, openExternal: (url: string) => void opened.push(url) }
}

describe('外链白名单（core/url-policy.cjs）', () => {
  it('只放行 http / https / mailto', () => {
    expect(policy.ALLOWED_SCHEMES).toEqual(['http:', 'https:', 'mailto:'])
  })

  it('放行：三种协议，大小写和空格都不影响', () => {
    for (const url of [
      'http://example.com',
      'https://example.com/a/b?c=1#d',
      'HTTPS://Example.com',
      '  https://example.com  ',
      'mailto:someone@example.com',
    ]) {
      expect(policy.isOpenableExternal(url), url).toBe(true)
    }
  })

  it('★ 拒绝：本地文件 / 脚本 / 数据 / 系统设置页（审计问题 18 的正题）', () => {
    for (const url of [
      'file:///C:/Windows/system.ini',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'ms-settings:privacy',
      'blob:https://example.com/xxxx',
      'about:blank',
      'chrome://settings',
      'shell:startup',
    ]) {
      expect(policy.isOpenableExternal(url), url).toBe(false)
    }
  })

  it('拒绝：空值与非字符串（拿不到协议就当不允许）', () => {
    for (const raw of ['', '   ', 'example.com', undefined, null, 42, {}, [], true]) {
      expect(policy.isOpenableExternal(raw), String(raw)).toBe(false)
      expect(policy.schemeOf(raw)).toBe('')
    }
  })

  it('★ 行为：白名单内才真的交给系统（而且原样传，不改写）', () => {
    const shell = fakeShell()
    expect(policy.openExternalSafe(shell, 'https://example.com/x', 'test')).toBe(true)
    expect(shell.opened).toEqual(['https://example.com/x'])
  })

  it('★ 行为：不在白名单里就**一次都不调用**（不是「先开再拦」）', () => {
    const shell = fakeShell()
    expect(policy.openExternalSafe(shell, 'file:///C:/Windows/system.ini', 'test')).toBe(false)
    expect(policy.openExternalSafe(shell, 'javascript:alert(1)', 'test')).toBe(false)
    expect(shell.opened).toEqual([])
  })

  it('shell 不可用时也不抛（自检环境里 electron 是假的）', () => {
    expect(policy.openExternalSafe(null, 'https://example.com', 'test')).toBe(false)
    expect(policy.openExternalSafe({}, 'https://example.com', 'test')).toBe(false)
  })

  it('openExternal 抛错也不往外冒（点链接不能把主进程弄挂）', () => {
    const shell = {
      openExternal: () => {
        throw new Error('boom')
      },
    }
    expect(policy.openExternalSafe(shell, 'https://example.com', 'test')).toBe(false)
  })
})

describe('渲染层与主进程的口径不能打架', () => {
  const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i

  it('★ 渲染层放行的**绝对地址**，主进程必须也放行（否则画出来点不动）', () => {
    const urls = [
      'http://example.com',
      'https://example.com/a',
      'MAILTO:someone@example.com',
      'file:///C:/Windows/system.ini',
      'javascript:alert(1)',
      'data:text/html,x',
      'ms-settings:privacy',
    ]
    for (const url of urls) {
      if (!ABSOLUTE.test(url)) continue
      if (isSafeHref(url)) {
        expect(policy.isOpenableExternal(url), `渲染层放行但主进程拦：${url}`).toBe(true)
      }
    }
  })

  it('渲染层自己也不再放行 file:（本批改的就是它）', () => {
    expect(isSafeHref('file:///C:/Windows/system.ini')).toBe(false)
    expect(isSafeHref('file:///etc/passwd')).toBe(false)
  })

  it('渲染层仍然放行相对地址与锚点（站内跳转、图片路径要用）', () => {
    for (const href of [
      'https://example.com',
      'mailto:a@b.c',
      '#小节',
      '/a.md',
      './a.md',
      '../a.md',
    ]) {
      expect(isSafeHref(href), href).toBe(true)
    }
  })
})

describe('主进程只有一条外抛口', () => {
  const mainSrc = readFileSync(join(ROOT, 'electron/main.cjs'), 'utf8')

  it('★ main.cjs 不再直接 shell.openExternal，而是走白名单', () => {
    expect(mainSrc).not.toContain('shell.openExternal(')
    expect(mainSrc).toContain('openExternalSafe(shell, url')
  })
})
