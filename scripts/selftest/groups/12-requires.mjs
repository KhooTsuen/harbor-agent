import { readdirSync } from 'node:fs'
import path from 'node:path'
import { check, group } from '../harness.mjs'
import { ROOT, existsSync, readFileSync } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   模块引用：相对 require 的路径必须真的存在

   ★ 真机抓到的：`electron/handlers/provider.cjs` 里写的是

       require('./core/llm.cjs')

   但那个文件在 `handlers/` 下，应该是 `../core/llm.cjs`。
   用户在「设置 → 模型」点「刷新」拉模型清单时，界面上直接弹出：

       Error invoking remote method 'provider:listModels':
       Error: Cannot find module '/core/llm.cjs'

   ── 为什么一直没人发现 ──
   · `.cjs` 不过 tsc，路径写错编译器不管
   · 这个 require 写在 **handler 内部**（懒加载），只有点按钮时才执行
   · 所以开发、单测、打包自检全绿，一路溜到用户手里

   和之前那个「`ipcMain` 忘 require」是同一类洞：**只有真跑才看得见**。
   这里用静态扫描把它提前：解析不到的相对 require 一律报红。

   分工：tsc 管 `.ts/.tsx`，这一个管 `.cjs/.mjs` 的 `require` 路径。
   ══════════════════════════════════════════════════════════════ */

/** 递归列文件（跳过 node_modules / dist / 隐藏目录） */
function walkFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

/**
 * 去掉注释再扫。
 *
 * 不加这一步会**误报**：本文件上面那段说明里就写着 `require('./core/llm.cjs')`，
 * 扫描器会把「举例说明的那个错路径」当成真的引用。
 * （同类坑之前踩过一次 —— 用 grep 找锚点，命中的是注释里的那一个。）
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

export async function run() {
  group('模块引用 / 相对 require 路径')

  const missing = []
  const pattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g

  for (const dir of ['electron', 'scripts', 'tools']) {
    for (const file of walkFiles(path.join(ROOT, dir))) {
      if (!/\.(cjs|mjs|js)$/.test(file)) continue
      const source = stripComments(readFileSync(file, 'utf8'))
      for (const match of source.matchAll(pattern)) {
        const target = path.resolve(path.dirname(file), match[1])
        /* 和 Node 一样按 .cjs/.mjs/.js/index 依次试 */
        const candidates = [
          target,
          `${target}.cjs`,
          `${target}.mjs`,
          `${target}.js`,
          path.join(target, 'index.cjs'),
          path.join(target, 'index.js'),
        ]
        if (!candidates.some((c) => existsSync(c))) {
          missing.push(`${file.slice(ROOT.length)} → ${match[1]}`)
        }
      }
    }
  }

  check('相对 require 都指向真实文件', missing.length === 0, missing.join(' | '))
}
