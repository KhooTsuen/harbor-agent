/**
 * 打包时「主进程到底要哪些第三方包」—— 唯一真相源。
 *
 * ── 为什么要算，而不是照 `npm ls --omit=dev --all` 全拷（2026-11-03）──
 * `npm ls --omit=dev` 的语义是「生产依赖」，但 `package.json` 的 `dependencies`
 * 里混着一堆**只有渲染层用**的包（mermaid / lucide-react / react-dom …）——
 * 它们由 vite 打进 `dist/` 那个 bundle，主进程一个都不 require。
 * 实测：会拷 175 个包 / 333MB，其中 **220MB 主进程根本碰不到**；
 * 压进 zip 仍占 **51MB**（mermaid 一个就 26.4MB）。
 * 拷也要时间 —— 这 333MB 拷一遍 **52.1 秒**，期间进度条挪得很慢，
 * 外面看起来就像「卡死」（2026-11-03 真被 Ctrl+C 掐过一次）。
 *
 * ── 算法 ──
 * ① 从 `electron/` 下所有 `.cjs` / `.mjs` / `.js` 出发（main / preload / 独立进程入口都在里面）；
 * ② 沿**字面量** `require('x')` / `from 'x'` / `import('x')` 递归：相对路径跟着走，
 *    裸包名记下；③ 每个包按它自己 `package.json` 的 dependencies 继续展开，得到闭包；
 * ④ 与 `npm ls --omit=dev --all --parseable` 取交集 —— 只拷「闭包里 **且** 生产依赖」的。
 *
 * ── 这个算法唯一的洞，以及怎么堵 ──
 * 它看不见**拼出来的** `require(变量)`。那种写法一旦出现，算出来的闭包就会漏包，
 * 表现是「打包版某个功能运行时报 Cannot find module」—— 而源码树里一切正常，
 * 最坏的一类 bug。所以扫描时把每个非字面量 `require` / `import()` 都揪出来：
 * **没在 `DYNAMIC_OK` 里登记过的，直接让打包失败**（不是警告）。
 * 要在主进程里新写一个动态 require，就得来这儿写一行「为什么它不需要进包」。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { builtinModules } from 'node:module'

const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/**
 * 允许出现的「非字面量 require」—— 每条都要写清为什么它不影响打包。
 * 只认 `文件:行号` 这个键（改了代码挪了行，这里就会报红，逼着回来看一眼）。
 */
const DYNAMIC_OK = new Map([
  [
    'electron/core/plugins.cjs:255',
    '插件加载：路径来自用户自己的插件目录，跟 node_modules 无关',
  ],
])

/** 不管闭包算出什么，都**一定**进包的（闭包看不见的使用方式，或安全兜底） */
const ALWAYS_KEEP = new Map([
  ['node-pty', '由 copyNativeDeps 单独拷（这里排除，但必须留在清单里）'],
  ['@napi-rs/canvas', 'pdfjs 的可选依赖，渲染路径兜底 —— 先留着，砍它要单独验 PDF'],
  ['@napi-rs/canvas-win32-x64-msvc', '同上：本平台的预编译产物'],
])

const SPEC_RE =
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)|require\.resolve\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const DYNAMIC_RE = /require\s*\(|import\s*\(/g

/**
 * `pdfjs-dist/build/pdf.mjs` → `pdfjs-dist`；`@mermaid-js/parser` → 原样。
 *
 * ★ 先归一化分隔符再切：`npm ls --parseable` 在 Windows 上给的是**反斜杠**
 *   （`@xmldom\xmldom`），而源码里 require 出来的是正斜杠。不归一化的话
 *   `@xmldom/xmldom` 会被当成一个叫「@xmldom\xmldom」的怪名字，判定成「闭包里没有」
 *   → 静默跳过 → 打包版 docx 解析报 Cannot find module。
 *   （2026-11-03 预演时就是这么抓到的。）
 */
export function pkgNameOf(spec) {
  const norm = String(spec).replace(/\\/g, '/')
  /* 嵌套包（`katex/node_modules/commander`）按**最外层**包判定：
     外层被跳过，嵌套的也不该进来；外层要留，嵌套的跟着留。 */
  const outer = norm.split('/node_modules/')[0]
  const parts = outer.split('/')
  return outer.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

/** 递归收集目录下要扫的源码文件（跳过 node_modules） */
function collectSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') collectSources(full, out)
    } else if (['.cjs', '.mjs', '.js'].includes(extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

/** 逐个 `require(` / `import(` 检查是不是字面量；不是就记下来 */
function findDynamicRequires(file, relFile, text) {
  const hits = []
  text.split(/\r?\n/).forEach((line, index) => {
    /* 注释行不算 —— 文件头里写一句「只能 `await import()`」不该让打包失败。
       （2026-11-03 预演时 `file-extract-docs.cjs` 的文档注释就被误抓过一次。） */
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return
    for (const re of [/require\s*\(/g, /import\s*\(/g]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(line))) {
        /* 落在行尾注释里的也放过 */
        const commentAt = line.indexOf('//')
        if (commentAt >= 0 && m.index > commentAt) continue
        const after = line.slice(m.index + m[0].length).trimStart()
        /* 字面量 = 引号里没插值；反引号里带 ${ 也算动态 */
        const literal = /^['"][^'"]*['"]\s*[,)]/.test(after) || /^`[^`$]*`\s*[,)]/.test(after)
        if (!literal) hits.push(`${relFile}:${index + 1}`)
      }
    }
  })
  return hits
}

/** 沿相对路径找真实文件（.cjs / .js / .mjs / index.* / package.json 的 main） */
function resolveRelFile(base) {
  const candidates = [
    base,
    `${base}.cjs`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, 'index.cjs'),
    join(base, 'index.js'),
    join(base, 'index.mjs'),
  ]
  for (const cand of candidates) {
    try {
      if (existsSync(cand) && statSync(cand).isFile()) return cand
    } catch {
      /* 读不到就当不存在，下一个 */
    }
  }
  return null
}

/**
 * 算出「主进程真正会加载到的包」集合。
 *
 * @param {string} ROOT 仓库根
 * @returns {{ packages: Set<string>, scanned: number, dynamicErrors: string[] }}
 */
export function scanMainClosure(ROOT) {
  const electronDir = join(ROOT, 'electron')
  const queue = collectSources(electronDir)
  const visited = new Set()
  const packages = new Set()
  const dynamicErrors = []

  while (queue.length > 0) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)

    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    const relFile = file.slice(ROOT.length + 1).replace(/\\/g, '/')
    for (const hit of findDynamicRequires(file, relFile, text)) {
      if (!DYNAMIC_OK.has(hit)) {
        dynamicErrors.push(`${hit}  —— 动态 require 逃过了闭包算法（是新的就登记进 DYNAMIC_OK，并写清为什么不用进包）`)
      }
    }

    SPEC_RE.lastIndex = 0
    let m
    while ((m = SPEC_RE.exec(text))) {
      const spec = m[1] || m[2] || m[3] || m[4]
      if (!spec) continue
      if (spec.startsWith('.') || /^[a-zA-Z]:[\\/]/.test(spec) || spec.startsWith('/')) {
        const target = resolveRelFile(resolve(dirname(file), spec))
        if (target && !visited.has(target)) queue.push(target)
      } else if (!BUILTIN.has(spec)) {
        packages.add(pkgNameOf(spec))
      }
    }
  }

  return { packages, scanned: visited.size, dynamicErrors }
}

/** 按各包 package.json 的依赖声明，把闭包补全到传递依赖 */
export function expandClosure(ROOT, seeds) {
  const nm = join(ROOT, 'node_modules')
  const closure = new Set()
  const add = (name) => {
    if (closure.has(name)) return
    closure.add(name)
    const pj = join(nm, name, 'package.json')
    if (!existsSync(pj)) return
    let meta
    try {
      meta = JSON.parse(readFileSync(pj, 'utf8'))
    } catch {
      return
    }
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(meta[key] ?? {})) add(dep)
    }
  }
  for (const name of seeds) add(name)
  return closure
}

/**
 * 决定这次打包要拷哪些「相对 node_modules 的路径」。
 *
 * @param {string} ROOT
 * @param {string[]} shipped `npm ls --omit=dev --all --parseable` 解析出的相对路径
 * @returns {{ copy: string[], skip: { rel: string, name: string }[], closure: number, dynamicErrors: string[] }}
 */
export function planProdDeps(ROOT, shipped) {
  const { packages, scanned, dynamicErrors } = scanMainClosure(ROOT)
  const closure = expandClosure(ROOT, packages)

  const copy = []
  const skip = []
  for (const rel of shipped) {
    const name = pkgNameOf(rel)
    if (closure.has(name) || ALWAYS_KEEP.has(name)) copy.push(rel)
    else skip.push({ rel, name })
  }

  return { copy, skip, closure: closure.size, scanned, dynamicErrors, kept: ALWAYS_KEEP.size }
}

/** `npm ls` 那条命令：Windows 上 npm 是 .cmd，Node 24 起必须经 shell */
export function listShipped(ROOT, spawnSync) {
  const nm = join(ROOT, 'node_modules')
  const result = spawnSync('npm ls --omit=dev --all --parseable', {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    /* 必须给超时：没有它的时候 npm 一挂住，整个打包就停在这一句上，
       外面看到的是「卡住」而不是「失败」。 */
    timeout: 120_000,
  })
  if (result.error) {
    throw new Error(`npm ls 没跑成（${result.error.code ?? result.error.message}）—— 依赖没拷进去，打包不该往下走`)
  }
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith(nm) && existsSync(line))
    .map((line) => line.slice(nm.length + 1))
}
