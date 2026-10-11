/**
 * 安全套件：隔离环境
 *
 * 清单第 0 节的头两条硬规矩 —— 「在独立临时用户数据目录运行，绝不对真实用户数据
 * 执行攻击测试」「网络请求只发到本机 mock」—— 都要在这里**结构上**保证，
 * 而不是靠每个套件自觉。
 *
 * 隔离怎么做：`paths.markPackaged(<临时 base>)` 一调，`rootDir()` 就指到那个 base，
 * `DIRS.*` 全落到 `<base>/data` 下。**必须在 require 任何别的内核模块之前调** ——
 * 内核里好几个模块（config / credentials / log）在首次调用时就把路径算好并缓存了。
 * 所以这个文件是套件的**第一个 import**。
 *
 * 为什么不用 `isSelftestRun()` 那条路：它靠「入口脚本是不是 selftest.mjs」判断，
 * 而我们的入口是 `scripts/security/run.mjs`，命中不了 —— 不 markPackaged 的话
 * `dataDir()` 会返回**真 data**，测试假数据就灌进用户目录了。
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 隔离基准目录（在真 data 下开一个独立子目录；`data/` 整体是 gitignore 的） */
const BASE = path.join(ROOT, 'data', 'security-data')

const paths = require(path.join(ROOT, 'electron/core/paths.cjs'))
paths.markPackaged(BASE)

/** 假密钥哨兵：任何日志/报告/导出里出现它，就是泄露（全用同一根，好扫） */
export const SENTINEL_KEY = 'sk-SENTINEL-LEAK-CANARY-0123456789abcdef'
export const SENTINEL_PAT = 'github_pat_SENTINELCANARY0123456789abcdef'

/** 工作区（供路径类用例当「授权根目录」用） */
export const WORKSPACE = path.join(BASE, 'workspace')

export function prepare() {
  fs.rmSync(BASE, { recursive: true, force: true })
  fs.mkdirSync(WORKSPACE, { recursive: true })
  paths.ensureDirs()
}

export function cleanup() {
  fs.rmSync(BASE, { recursive: true, force: true })
}

/** 在隔离区内造一个临时目录 */
export function tmpDir(name) {
  const dir = path.join(BASE, 'tmp', name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 起一个只在 127.0.0.1 上的 mock HTTP 服务。
 * 返回 { url, port, hits, close } —— `hits` 是收到的请求数，
 * 用来做「外发计数必须为 0」这类硬观测（清单第 10.4 条）。
 */
export async function startMockServer(handler) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url })
    if (handler) return handler(req, res)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export { fs, path, require }
