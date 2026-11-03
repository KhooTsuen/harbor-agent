/**
 * 打包时把主进程要用的第三方包放进 `resources/app/node_modules`。
 *
 * 从 `build-portable.mjs` 拆出来的 —— 那边加完这一块就 339 行，破了硬约束 #2
 * （单文件 ≤ 300 行）。这两块是同一件事的两半（哪些包、怎么拷），放一起才看得出关系。
 *
 * 为什么必须拷：主进程是 CJS，`require('pdfjs-dist')` 之类只能在
 * `resources/app/node_modules` 下找到；漏一个不是「报个错」，而是**运行时该功能不可用**。
 *
 * ★ 「哪些包」的答案不在这个文件里 —— 在 `prod-deps-closure.mjs`（唯一真相源）。
 *   以前这里是「`npm ls --omit=dev` 列出什么就全拷」，于是把 mermaid（120MB）、
 *   lucide-react、react-dom 这些**只有渲染层用**的包也搬进了安装包：
 *   175 个包 / 333MB，主进程碰不到其中 220MB，压进 zip 仍剩 51MB。
 *   现在按主进程的 require 闭包裁，并把这个差额**打进日志**（不是悄悄少拷）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { listShipped, planProdDeps } from './prod-deps-closure.mjs'

/** 递归算目录体积（拷贝前先知道总量，进度才有分母） */
function sizeOf(dir) {
  let total = 0
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(d, entry.name)
      try {
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) total += statSync(full).size
      } catch {
        /* 读不到就跳过，不该让打包挂在算体积上 */
      }
    }
  }
  walk(dir)
  return total
}

const mb = (bytes) => (bytes / 1048576).toFixed(1)

/**
 * 主进程的**生产依赖**：照 `prod-deps-closure.mjs` 算出的闭包裁，只拷真正会 require 的。
 *
 * node-pty 跳过 —— 它由 `copyNativeDeps` 单独处理（只拷本平台预编译）。
 */
export function copyProdDeps(ROOT, APP_OUT, step) {
  const nm = join(ROOT, 'node_modules')
  const dest = join(APP_OUT, 'node_modules')
  const shipped = listShipped(ROOT, spawnSync)
  const plan = planProdDeps(ROOT, shipped)

  /* 主进程里有「拼出来的 require」= 闭包算不准，宁可不打包也不能打出一个缺包的版本 */
  if (plan.dynamicErrors.length > 0) {
    throw new Error(
      `主进程有 ${plan.dynamicErrors.length} 处动态 require，依赖闭包算不准：\n  ${plan.dynamicErrors.join('\n  ')}`,
    )
  }

  const todo = plan.copy.filter((rel) => rel !== 'node-pty')
  const sizes = new Map(todo.map((rel) => [rel, sizeOf(join(nm, rel))]))
  const totalBytes = [...sizes.values()].reduce((sum, n) => sum + n, 0)
  const skippedBytes = plan.skip.reduce((sum, item) => sum + sizeOf(join(nm, item.rel)), 0)

  step(
    `主进程扫了 ${plan.scanned} 个文件，闭包 ${plan.closure} 个包；要拷 ${todo.length} 个 / ${mb(totalBytes)}MB` +
      `，跳过 ${plan.skip.length} 个只给渲染层用的 / ${mb(skippedBytes)}MB`,
  )

  /* 进度：以前是「每 20 个包一行」，但前 20 个包里就有 mermaid（120MB），
     头一行字要等 25 秒 —— 外面看起来还是卡住。改成按**时间**报，最多每 2 秒一行，
     并且带上「已拷 MB / 总量」，不动的时候一眼能看出是真的没动。 */
  let copied = 0
  let bytes = 0
  let lastAt = Date.now()
  for (const rel of todo) {
    const to = join(dest, rel)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(join(nm, rel), to, { recursive: true })
    copied++
    bytes += sizes.get(rel) ?? 0
    if (Date.now() - lastAt >= 2000 || copied === todo.length) {
      lastAt = Date.now()
      const pct = totalBytes > 0 ? Math.round((bytes / totalBytes) * 100) : 100
      step(`已拷 ${copied}/${todo.length} 个包 · ${mb(bytes)}/${mb(totalBytes)}MB（${pct}%）`)
    }
  }

  /* 跳过了什么要留痕：将来某个功能在打包版里挂了，第一件事就是回来看这张单子。
     只列前 12 个 + 总数 —— 145 个名字刷一屏，反而会把真正要紧的几行挤掉。 */
  if (plan.skip.length > 0) {
    const unique = [...new Set(plan.skip.map((item) => item.name))].sort()
    const head = unique.slice(0, 12).join(', ')
    step(`未拷（主进程零引用）${unique.length} 个：${head}${unique.length > 12 ? ` …等` : ''}`)
  }
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
