/**
 * 打包时把主进程要用的第三方包放进 `resources/app/node_modules`。
 *
 * 从 `build-portable.mjs` 拆出来的 —— 那边加完这一块就 339 行，破了硬约束 #2
 * （单文件 ≤ 300 行）。这两块是同一件事的两半（哪些包、怎么拷），放一起才看得出关系。
 *
 * 为什么必须拷：主进程是 CJS，`require('pdfjs-dist')` 之类只能在
 * `resources/app/node_modules` 下找到；漏一个不是「报个错」，而是**运行时该功能不可用**。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, sep } from 'node:path'

/**
 * 主进程的**生产依赖**全表：直接问 `npm ls --omit=dev --all --parseable`，
 * 照着相对 node_modules 的路径整份拷。
 *
 * 好处：以后再加依赖**不用回来改这里**；devDependencies（electron / vite / vitest…）
 * 天然不进来。以前只硬拷 node-pty，2026-10-08 加文件解析库时踩到「打包版附件全挂」。
 *
 * node-pty 跳过 —— 它由 `copyNativeDeps` 单独处理（只拷本平台预编译）。
 * `@napi-rs/canvas` 是 pdfjs 的**可选**依赖，没装也不影响（PDF 走纯文本抽取）。
 */
export function copyProdDeps(ROOT, APP_OUT, step) {
  /* Windows 上 npm 是 .cmd，Node 24 起**必须**经 shell 才起得动（CVE-2024-27980 之后）。
     整条命令写成字符串（不给 args 数组）—— 那样才不会触发 DEP0190 那条警告。 */
  const result = spawnSync('npm ls --omit=dev --all --parseable', {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
  })
  const lines = String(result.stdout ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
  const nm = join(ROOT, 'node_modules')
  const dest = join(APP_OUT, 'node_modules')

  let copied = 0
  for (const line of lines) {
    if (!line.startsWith(nm + sep) || !existsSync(line)) continue
    const rel = line.slice(nm.length + 1)
    if (rel === 'node-pty') continue
    const to = join(dest, rel)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(line, to, { recursive: true })
    copied++
  }
  step(`主进程依赖已放入：${copied} 个包（npm ls --omit=dev --all）`)
}

/**
 * 原生模块（node-pty）：它是**运行时**依赖，dist/ 里只有前端 bundle，
 * 主进程 `require('node-pty')` 得在 resources/app/node_modules 下找得到 —— 漏了就是
 * 「终端面板打不开」，报 Cannot find module 'node-pty'。
 *
 * 只拷跑起来必需的，别把 64MB 全搬过来：package.json（require 靠它解析入口）、lib/、
 * prebuilds/win32-x64/（pty.node + conpty.dll + OpenConsole.exe，约 30MB）。不拷
 * darwin-* / win32-arm64 的预编译（28MB，Windows x64 用不到），也不拷 third_party/、src/。
 */
export function copyNativeDeps(ROOT, APP_OUT, step) {
  const from = join(ROOT, 'node_modules', 'node-pty')
  if (!existsSync(from)) {
    step('⚠️  没找到 node-pty —— 终端功能会不可用（先跑 npm install node-pty）')
    return
  }

  const to = join(APP_OUT, 'node_modules', 'node-pty')
  mkdirSync(to, { recursive: true })
  for (const item of ['package.json', 'lib']) {
    cpSync(join(from, item), join(to, item), { recursive: true })
  }

  const platform = `${process.platform}-${process.arch}`
  const prebuild = join(from, 'prebuilds', platform)
  if (existsSync(prebuild)) {
    cpSync(prebuild, join(to, 'prebuilds', platform), { recursive: true })
    step(`原生模块已放入：node-pty（${platform}）`)
  } else {
    step(`⚠️  node-pty 缺 ${platform} 的预编译产物 —— 终端会不可用`)
  }
}
