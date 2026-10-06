/**
 * 自检 / 工具：download（真机反馈 9b）
 *
 * 自检**不联网**，所以这里把 `globalThis.fetch` 换成一个假的 Response ——
 * 断言的是工具自己的逻辑：协议白名单、大小上限、进度怎么报、落盘走哪条路。
 * （这套「替换全局函数造错误/造响应」的写法与 118-safe-write 同一路子。）
 */
import fs from 'node:fs'
import { join, require, ROOT, SANDBOX, ctx } from '../env.mjs'
import { check, group } from '../harness.mjs'

const download = require(join(ROOT, 'electron/core/tools/download.cjs'))
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))
const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))

/** 用假的 fetch 跑一段，结束后一定恢复（真 fetch 别被留下） */
function withFakeFetch(spec, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: spec.status === undefined || (spec.status >= 200 && spec.status < 300),
    status: spec.status ?? 200,
    statusText: spec.statusText ?? 'OK',
    headers: {
      get: (key) =>
        String(key).toLowerCase() === 'content-length' ? String(spec.contentLength ?? '') : null,
    },
    body: (async function* () {
      for (const chunk of spec.chunks ?? []) yield Buffer.from(chunk)
    })(),
  })
  try {
    return fn()
  } finally {
    globalThis.fetch = real
  }
}

/** 直接调工具的 run（进度靠 ctx.progress —— tool-runner 就是这么注入的） */
async function runTool(url, path) {
  const progress = []
  let out = ''
  let error = ''
  try {
    out = await download.run({ url, path }, { workdir: SANDBOX, progress: (p) => progress.push(p) })
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  return { out, error, progress }
}

export async function run() {
  group('工具 / download')

  const target = join(SANDBOX, 'download-target.bin')
  const clear = () => {
    try {
      fs.unlinkSync(target)
    } catch {
      /* 本来就没有更好 */
    }
  }

  /* ① 协议白名单：file:// / 别的协议一律拒（模型嘴里说出来很危险的正是这类） */
  const bad = await runTool('file:///C:/Windows/System32/drivers/etc/hosts', target)
  check(
    '★ 只吃 http/https：file:// 被拒',
    bad.error.includes('只支持 http/https') && !fs.existsSync(target),
    bad.error || '(没报错)',
  )

  /* ② 正常下载：内容落盘 + 字节对得上 */
  clear()
  const ok = await withFakeFetch({ chunks: ['hello ', 'world'], contentLength: 11 }, () =>
    runTool('https://example.com/a.txt', target),
  )
  check(
    '正常下载：内容落盘且字节正确',
    fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'hello world',
    ok.out || ok.error,
  )
  check('输出里带上「下载到哪」与体积', ok.out.includes('已下载') && ok.out.includes('11 B'), ok.out)

  /* ③ 进度：先报 0%，随分片递增，最后 100% 且 done=true */
  const pct = ok.progress.map((p) => p.percent)
  check(
    '★ 进度事件：0 → 中间 → 100（收尾标 done）',
    pct[0] === 0 && pct[pct.length - 1] === 100 && ok.progress[ok.progress.length - 1].done === true,
    JSON.stringify(ok.progress),
  )
  check('进度里带了人话（已收 / 总量）', String(ok.progress[0]?.note ?? '').length > 0, JSON.stringify(ok.progress[0]))

  /* ④ 没有 content-length 时：百分比报不出来 → null（不是 0，也不是猜一个） */
  clear()
  const noLen = await withFakeFetch({ chunks: ['abc'] }, () => runTool('https://example.com/b.bin', target))
  check(
    '★ 没有 content-length → percent 报 null（「还在动」不等于 0%）',
    noLen.progress.some((p) => p.percent === null),
    JSON.stringify(noLen.progress),
  )

  /* ⑤ 声称超过上限 → 直接拒，**不写盘**（别先下 200MB 再说太big） */
  clear()
  const tooBig = await withFakeFetch({ chunks: ['x'], contentLength: 300 * 1024 * 1024 }, () =>
    runTool('https://example.com/huge.bin', target),
  )
  check(
    '★ 超过 200MB 上限：直接拒且不写盘',
    tooBig.error.includes('文件太大') && !fs.existsSync(target),
    tooBig.error || '(没报错)',
  )

  /* ⑥ HTTP 错误码：把状态码说出来，别只说「失败」 */
  clear()
  const notFound = await withFakeFetch({ status: 404, statusText: 'Not Found' }, () =>
    runTool('https://example.com/missing.bin', target),
  )
  check('404 如实报状态码', notFound.error.includes('404'), notFound.error || '(没报错)')

  /* ⑦ 接线：注册表 / 权限档 / 联网门 / 原子写 */
  check('注册表里能找到它', Boolean(registry.byName('download')), JSON.stringify(Object.keys(registry).slice(0, 6)))
  check(
    '★ 算「写操作」（只读档会拦、ask 档会先问）',
    registry.WRITE_TOOLS.has('download') && registry.FILE_WRITERS.has('download'),
    'WRITE_TOOLS / FILE_WRITERS 里没有 download',
  )
  const src = fs.readFileSync(join(ROOT, 'electron/core/tools/download.cjs'), 'utf8')
  check('★ 落盘走 safe-write 的原子写（不是裸 writeFileSync）', src.includes('writeAtomic'), '没看到 writeAtomic')
  const netBlocked = await tools.execute(
    'download',
    { url: 'https://example.com/x.bin', path: 'x.bin' },
    { ...ctx, allowNetwork: false, permission: 'full', confirm: async () => true },
  )
  check(
    '★ 本轮说「别联网」时被拦下',
    String(netBlocked).includes('禁止联网'),
    String(netBlocked).slice(0, 80),
  )
  /*
   * 子代理 v1 把「这次调用的 ctx」整块搬进了 `tool-run-ctx.cjs`（tool-runner 贴着
   * 300 行红线）。所以守卫要钉**两处**：注入本体在新家、tool-runner 真的用它 ——
   * 只钉一边的话，「搬走了但没接上」这种接错照样能全绿（AGENT.md 第 9 条）。
   */
  const ctxSrc = fs.readFileSync(join(ROOT, 'electron/core/tool-run-ctx.cjs'), 'utf8')
  check(
    '★ tool-run-ctx 会注入 ctx.progress 并发 agent.tool.progress',
    ctxSrc.includes("type: 'agent.tool.progress'") && ctxSrc.includes('progress: (payload = {})'),
    'tool-run-ctx 里找不到进度注入',
  )
  const runnerSrc = fs.readFileSync(join(ROOT, 'electron/core/tool-runner.cjs'), 'utf8')
  check(
    '★ tool-runner 真的调了它（搬走了也要接上）',
    runnerSrc.includes('buildRunCtx(') && runnerSrc.includes('tool-run-ctx.cjs'),
    'tool-runner 没接上 tool-run-ctx',
  )

  clear()
}
