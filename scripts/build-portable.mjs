/**
 * 打包成便携版
 *
 * Electron 应用的本质就是「一个 exe + 一个 resources 文件夹」，
 * 自己拼就行，不需要 electron-builder。
 *
 * 三个必须记住的点（参考实现那边踩过）：
 *   ① resources/app/package.json **必须有**，缺了会静默退出、没有任何报错
 *   ② data 目录要**整体保留**，不能备份名单里的子目录（会漏东西）
 *   ③ 正在运行的实例要先关掉，否则文件被占用
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/* 产出的目录名与 exe 名跟着产品名走（Harbor）—— 见 package.json 的 build.productName */
const OUT = join(ROOT, 'dist-portable', 'Harbor')
const APP_OUT = join(OUT, 'resources', 'app')
const STAGE = join(ROOT, 'dist-portable', '.data-stage')
const ELECTRON_DIST = join(ROOT, 'node_modules', 'electron', 'dist')
const APP_NAME = 'Harbor.exe'

const step = (msg) => console.log(`  ${msg}`)

/* ── 0. 关掉正在运行的实例 ─────────────────────────────── */

async function killRunning() {
  if (process.platform !== 'win32') return
  try {
    await new Promise((ok) => {
      const child = spawn('taskkill', ['/F', '/IM', APP_NAME], { stdio: 'ignore' })
      child.on('exit', ok)
      child.on('error', ok)
    })
  } catch {
    /* 没在跑就算了 */
  }
}

/* ── 1. 准备输出目录，但保住 data ──────────────────────── */

function prepareOut() {
  const dataDir = join(OUT, 'data')
  const hasData = existsSync(dataDir)

  /* 把 data 挪到一边（rename 比 copy 快，而且不会漏内容） */
  if (hasData) {
    if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true })
    renameSync(dataDir, STAGE)
    step('已把 data 目录暂存到一边')
  }

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  if (hasData) {
    renameSync(STAGE, join(OUT, 'data'))
    step('data 目录已放回（用户数据没丢）')
  }
}

/* ── 2. 复制 Electron 运行时 ───────────────────────────── */

function copyRuntime() {
  if (!existsSync(ELECTRON_DIST)) {
    throw new Error('找不到 Electron 运行时，先跑一次 npm install')
  }
  cpSync(ELECTRON_DIST, OUT, { recursive: true })
  step(`Electron 运行时已复制（${process.versions.electron ?? '?'}）`)

  /*
   * Electron 默认把 50 多种 Chromium 界面语言全部带进来。
   * 本软件界面目前只有中文，内嵌网页也不需要这些翻译包。
   * 保留中文和英文作为 Chromium 的安全回退，其余语言包删掉，
   * 不影响模型、文件、终端或 webview 功能。
   */
  const localesDir = join(OUT, 'locales')
  const keepLocales = new Set(['zh-CN.pak', 'en-US.pak', 'en-GB.pak'])
  if (existsSync(localesDir)) {
    for (const name of readdirSync(localesDir)) {
      if (!keepLocales.has(name)) rmSync(join(localesDir, name), { force: true })
    }
    step('已裁剪 Chromium 语言包（保留中文/英文）')
  }

  /* 自带的示例应用要去掉，否则会和我们的 app 抢 */
  const defaultApp = join(OUT, 'resources', 'default_app.asar')
  if (existsSync(defaultApp)) rmSync(defaultApp, { force: true })

  /* 改 exe 名字 */
  const srcExe = join(OUT, 'electron.exe')
  const dstExe = join(OUT, APP_NAME)
  if (existsSync(srcExe)) {
    renameSync(srcExe, dstExe)
    step(`exe 改名为 ${APP_NAME}`)
  }

  /* 换 exe 图标 —— 用 Win32 UpdateResource 直接覆盖，不用 rcedit
     （rcedit 那套会先「删除旧图标资源」，在某些机器上返回 1359 并弄坏句柄） */
  const ico = join(ROOT, 'build', 'icon.ico')
  const setter = join(ROOT, 'scripts', 'set-icon.py')
  if (existsSync(ico) && existsSync(setter) && existsSync(dstExe)) {
    try {
      const result = spawnSync('python', ['-X', 'utf8', setter, dstExe, ico], { encoding: 'utf8' })
      if (result.status === 0) step('exe 图标已替换')
      else step(`exe 图标替换失败（不影响运行）：${(result.stderr ?? '').slice(0, 120)}`)
    } catch (error) {
      step(`exe 图标替换失败（不影响运行）：${error instanceof Error ? error.message : error}`)
    }
  }
}

/* ── 3. 装我们的代码 ───────────────────────────────────── */

function copyApp() {
  mkdirSync(APP_OUT, { recursive: true })

  cpSync(join(ROOT, 'dist'), join(APP_OUT, 'dist'), { recursive: true })
  cpSync(join(ROOT, 'electron'), join(APP_OUT, 'electron'), { recursive: true })
  if (existsSync(join(ROOT, 'build'))) {
    cpSync(join(ROOT, 'build'), join(APP_OUT, 'build'), { recursive: true })
  }
  step('dist/ 和 electron/ 已放入 resources/app')

  /*
   * 关键：Electron 靠这个文件认「这里是个应用」。
   * 缺了它窗口打不开，而且**没有任何报错**。
   */
  const appVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
  writeFileSync(
    join(APP_OUT, 'package.json'),
    JSON.stringify(
      {
        name: 'personal-agent',
        version: appVersion,
        description: '本地优先的个人 AI Agent 工作台',
        main: 'electron/main.cjs',
      },
      null,
      2,
    ),
    'utf8',
  )
  step(`resources/app/package.json 已写入（v${appVersion}，缺了会静默退出）`)
}

/**
 * 原生模块（node-pty）必须跟着一起走。
 *
 * 它是**运行时**依赖，不是构建期依赖：dist/ 里只有前端 bundle，
 * 而 Electron 主进程 `require('node-pty')` 时得在
 * resources/app/node_modules 下找得到 —— 打包时漏了，
 * 症状是「终端面板打不开」，报 Cannot find module 'node-pty'。
 *
 * 只拷跑起来必需的，别把 64MB 全搬过来：
 *   package.json          require 靠它解析入口
 *   lib/                  JS 封装
 *   prebuilds/win32-x64/  pty.node + conpty.dll + OpenConsole.exe（约 30MB）
 *
 * 不拷 darwin-* / win32-arm64 的预编译（28MB，Windows x64 上用不到），
 * 也不拷 third_party/ 和 src/（那是重新编译才需要的源码）。
 */
function copyNativeDeps() {
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

/* ── 4. 自检 ───────────────────────────────────────────── */

function verify() {
  const must = [
    [join(OUT, APP_NAME), '主程序'],
    [join(APP_OUT, 'package.json'), '应用清单'],
    [join(APP_OUT, 'electron', 'main.cjs'), '主进程'],
    [join(APP_OUT, 'electron', 'preload.cjs'), '桥接层'],
    [join(APP_OUT, 'dist', 'index.html'), '界面'],
  ]

  console.log('\n  打包内容检查：')
  let ok = true
  for (const [file, label] of must) {
    const exists = existsSync(file)
    if (!exists) ok = false
    const size = exists ? `${(statSync(file).size / 1024).toFixed(1)} KB` : '—'
    console.log(`    ${exists ? '✅' : '❌'} ${label.padEnd(12)} ${size}`)
  }
  if (!ok) throw new Error('打包内容不完整')
}

/* ── 5. README 也带一份 ───────────────────────────────── */

function copyDocs() {
  const readme = join(ROOT, 'README.md')
  if (existsSync(readme)) cpSync(readme, join(OUT, 'README.md'))
  step('README.md 已带上')
}

/* ── 主流程 ───────────────────────────────────────────── */

async function main() {
  console.log('\n打包便携版...\n')

  await killRunning()
  prepareOut()
  copyRuntime()
  copyApp()
  copyNativeDeps()
  copyDocs()
  verify()

  const files = readdirSync(OUT)
  console.log(`\n  ✅ 打包完成：${OUT}`)
  console.log(`     顶层内容：${files.slice(0, 6).join('  ')}${files.length > 6 ? ' …' : ''}`)
  console.log('\n  整个文件夹可以搬到任何地方，删掉即卸载。')
  console.log('  数据在 data/ 里，重新打包不会丢。\n')
}

main().catch((error) => {
  console.error('\n  ❌ 打包失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
