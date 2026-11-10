import { readdirSync } from 'node:fs'
import path from 'node:path'
import { check, group } from '../harness.mjs'
import { ROOT, existsSync, readFileSync, require } from '../env.mjs'

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

  /*
   * groups/ 下的文件**只有**被 GROUPS 显式收进来才会跑。
   * 2026-10-03 差点被它坑到：新加了一组（`111-confirm-notify.mjs`），
   * 本地跑完发现总数没变 —— 因为忘了注册，它**静静地什么都没做**。
   * 所以在这儿钉住：目录里每个组文件都必须在清单里出现。
   * （`*-parts.mjs` 是给组文件拆行数用的帮手，不是组，跳过。）
   *
   * ⚠️ 2026-10-15：清单从 `selftest.mjs` 搬到了 `selftest/groups.mjs`（那边顶红线了）。
   * 这里**两份都扫** —— 清单住哪个文件都在网里，也防有人搬回去时把闸门落下。
   */
  const groupsDir = path.join(ROOT, 'scripts/selftest/groups')
  const manifestSrc = [
    readFileSync(path.join(ROOT, 'scripts/selftest.mjs'), 'utf8'),
    readFileSync(path.join(ROOT, 'scripts/selftest/groups.mjs'), 'utf8'),
  ].join('\n')
  const unregistered = readdirSync(groupsDir)
    .filter((f) => f.endsWith('.mjs') && !f.includes('-parts'))
    .filter((f) => !manifestSrc.includes(`groups/${f}'`))
  check(
    '★ groups/ 里每个自检组都挂在清单上（没注册 = 静默不跑）',
    unregistered.length === 0,
    unregistered.join(', '),
  )

  /* ── HTTP 客户端：网络栈要跟着环境走 ─────────────────────
   *
   * ★ 真机抓到的：用户挂着代理访问 APIMart，浏览器能开，Agent 却 `fetch failed`
   *   （UND_ERR_CONNECT_TIMEOUT）—— 因为 Electron 主进程的全局 fetch 是
   *   Node 的 undici，**不读系统代理**。换成 Chromium 的 `net.fetch` 就通了。
   *
   * 这里只能测「没有 Electron 时能不能退化」，因为自检就是纯 Node 环境；
   * 真正走代理那一半靠真机验证（CHANGELOG 0.48.0 有记录）。
   */
  group('HTTP / 网络栈选择')
  const http = require(path.join(ROOT, 'electron/core/http.cjs'))
  check('http.fetch 可用', typeof http.fetch === 'function')

  /*
   * 不缓存 globalThis.fetch —— 缓存了的话这一步会失败，
   * 而那个 bug 在真机上表现为「换了网络栈不重启不生效」，极难查。
   */
  const realFetch = globalThis.fetch
  let called = 0
  globalThis.fetch = async () => {
    called += 1
    return { ok: true }
  }
  await http.fetch('https://example.invalid/')
  globalThis.fetch = realFetch
  check('不缓存 fetch（缓存了打桩和换网络栈都会失效）', called === 1, String(called))

  /* ── 限长读响应体（第 11 项，2026-11-10）─────────────────
   *
   * 病：图片 / 模型错误体 / 搜索回包原来都是「先把整个 body 读进内存，
   * 读完了再看大小」—— 上游返回 1 GB 时内存已经被吃掉，再抛错也晚了。
   * 这里钉住「边读边停」，用一个**会一直吐字节**的假响应：真按流读就会在上限
   * 处停住；要是退回整读，这个测试会一直转到超时（等于当场报警）。
   */
  group('HTTP / 限长读响应体（边读边停）')
  const N = 64 // 每次吐 64 字节，够多次 read 才能看出「停在中间」
  const endless = (chunkText) => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: {
      getReader() {
        let stopped = false
        return {
          read: async () =>
            stopped ? { done: true } : { done: false, value: Buffer.from(chunkText) },
          cancel: async () => {
            stopped = true
          },
        }
      },
    },
  })

  const buf = await http.readBufferLimited(endless('x'.repeat(N)), { maxBytes: 100 })
  check('★★ 超出上限就截断（不是读完再判断）', buf.truncated === true, JSON.stringify(buf.bytes))
  check('★★ 只留到上限为止，多一字节都不进内存', buf.bytes === 100 && buf.buffer.length === 100)

  const under = await http.readBufferLimited(
    { status: 200, ok: true, headers: { get: () => null }, body: null, text: async () => 'abc' },
    { maxBytes: 10 },
  )
  check('★ 没超上限就不标截断', under.truncated === false && under.bytes === 3, JSON.stringify(under.bytes))

  /* 声明 Content-Length 超限 → 请求还没开始读就拒掉（省一次白读） */
  const overLimit = {
    ...endless('y'.repeat(N)),
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? '999999' : null) },
  }
  const declared = await http
    .readBufferLimited(overLimit, { maxBytes: 1000 })
    .then(() => 'no-throw')
    .catch((e) => String(e.message))
  check('★ Content-Length 声明超限时先拒（不读 body）', /太大/.test(declared), declared.slice(0, 80))

  const text = await http.readTextLimited(endless('a'.repeat(N)), { maxBytes: 32 })
  check('★★ 文本形态也截断（错误体摘要不会把内存吃光）', text.truncated && text.text.length === 32)
  check('★ 已取消的 signal 立刻抛 AbortError（不先读一遍）', await (async () => {
    const ac = new AbortController()
    ac.abort()
    try {
      await http.readTextLimited(endless('z'.repeat(N)), { maxBytes: 10, signal: ac.signal })
      return false
    } catch (error) {
      return error.name === 'AbortError'
    }
  })())
}
