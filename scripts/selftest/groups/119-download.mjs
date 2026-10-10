/**
 * 自检 / 工具：download（真机反馈 9b）
 *
 * 自检**不联网**，所以这里把 `globalThis.fetch` 换成一个假的 Response ——
 * 断言的是工具自己的逻辑：协议白名单、大小上限、进度怎么报、落盘走哪条路。
 * （这套「替换全局函数造错误/造响应」的写法与 118-safe-write 同一路子。）
 */
import fs from 'node:fs'
import path from 'node:path'
import { join, require, ROOT, SANDBOX, ctx } from '../env.mjs'
import { check, group } from '../harness.mjs'

const download = require(join(ROOT, 'electron/core/tools/download.cjs'))
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))
const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))
const engine = require(join(ROOT, 'electron/core/download-engine.cjs'))

/** 用假的 fetch 跑一段，结束后一定恢复（真 fetch 别被留下） */
async function withFakeFetch(spec, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: spec.status === undefined || (spec.status >= 200 && spec.status < 300),
    status: spec.status ?? 200,
    statusText: spec.statusText ?? 'OK',
    headers: {
      get: (key) => {
        const k = String(key).toLowerCase()
        return k === 'content-length' ? String(spec.contentLength ?? '') : null
      },
    },
    /* 引擎探测时会调这两个（200 走 body.cancel、206 走 arrayBuffer）—— 假响应也得有 */
    arrayBuffer: async () => new ArrayBuffer(0),
    body: Object.assign(
      (async function* () {
        for (const chunk of spec.chunks ?? []) yield Buffer.from(chunk)
      })(),
      { cancel: async () => {} },
    ),
  })
  try {
    /* ★ 必须 await：工具现在要跨多次 await 调 fetch（探测 + 分段），
       不 await 的话 finally 会在异步跑完之前就把真 fetch 换回来（真踩过） */
    return await fn()
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

  /* ⑤ 声称超过上限 → 直接拒，**不写盘**（别先下 3GB 再说太大） */
  clear()
  const tooBig = await withFakeFetch({ chunks: ['x'], contentLength: 3 * 1024 * 1024 * 1024 }, () =>
    runTool('https://example.com/huge.bin', target),
  )
  check(
    '★ 超过 2GB 上限：直接拒且不写盘',
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
  check(
    '★ 真正下文件的活交给 download-engine（工具不再自己读进内存）',
    src.includes('download-engine.cjs'),
    '没看到 download-engine',
  )
  const engineSrc = fs.readFileSync(join(ROOT, 'electron/core/download-engine.cjs'), 'utf8')
  check(
    '★ 引擎写 .part 再 rename（中途失败不留半截成品）',
    engineSrc.includes('.part') && engineSrc.includes('renameSync(partFile, file)'),
    '引擎里没看到 .part / rename',
  )
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

  /*
   * ── 下载管理器（台账 / 引擎分段 / 队列 / 接线，2026-10-11）──
   *
   * 并入本组而不是新开一组：`selftest.mjs` 的组清单是**手工列表**且文件贴着
   * 300 行红线，加一行 import 就超。这里断言的都不联网（台账 + 纯函数 + 源码接线）。
   */
  group('下载管理器 / 台账与队列')

  const store = require(join(ROOT, 'electron/core/download-store.cjs'))
  const engine = require(join(ROOT, 'electron/core/download-engine.cjs'))
  const queue = require(join(ROOT, 'electron/core/download-queue.cjs'))
  const ledger = join(SANDBOX, 'downloads-ledger.json')

  store.setFilePathForTest(ledger)
  const first = store.add({ url: 'https://example.com/a.bin', file: join(SANDBOX, 'a.bin') })
  check(
    '★ 新增任务是 queued —— 读盘**不会**把它回落成 paused（真踩过）',
    first.ok && store.list()[0]?.status === 'queued',
    `status=${store.list()[0]?.status}`,
  )

  const fell = store.settle()
  check(
    '★ settle()（模拟重启）把 queued/running 回落成 paused',
    fell === 1 && store.list()[0]?.status === 'paused',
    `fell=${fell} status=${store.list()[0]?.status}`,
  )

  const clash = store.add({ url: 'https://example.com/b.bin', file: join(SANDBOX, 'a.bin') })
  check('同一保存路径不允许第二条未完成任务', !clash.ok && String(clash.error).includes('没跑完'), clash.error)

  const limits = store.setLimits({ maxConcurrent: 99, maxKBps: -5, connections: 99 }).limits
  check(
    '★ 并发夹到 8 / 连接夹到 16 / 限速负数当 0',
    limits.maxConcurrent === 8 && limits.connections === 16 && limits.maxKBps === 0,
    JSON.stringify(limits),
  )

  store.patch(first.item.id, { status: 'done', received: 10, total: 10 })
  check('patch 写回状态与已收', store.get(first.item.id)?.status === 'done')
  const cleared = store.clearFinished()
  check(
    'clearFinished 清掉已结束的条目',
    cleared.ok && cleared.removed === 1 && store.list().length === 0,
    JSON.stringify(cleared),
  )

  const segs = engine.planSegments(10 * 1024 * 1024, 4)
  const contiguous = segs.every((s, i) => (i === 0 ? s.start === 0 : s.start === segs[i - 1].end + 1))
  check(
    '★ 分段连续且覆盖到末尾',
    segs.length === 4 && contiguous && segs[3].end === 10 * 1024 * 1024 - 1,
    JSON.stringify(segs),
  )
  check(
    '★ 小文件 / 未知大小 / 不支持 Range → 都不切段（回退单连接）',
    engine.planFor(1024, 4, true).segments.length === 1 &&
      engine.planFor(0, 4, true).segments.length === 1 &&
      engine.planFor(10 * 1024 * 1024, 4, false).segments.length === 1,
  )
  check(
    '★ 够大又支持 Range → 才切成 connections 段',
    engine.planFor(10 * 1024 * 1024, 4, true).segments.length === 4,
  )
  check('★ 切段阈值是 4MB（MIN_SEGMENT_BYTES）', engine.MIN_SEGMENT_BYTES === 4 * 1024 * 1024)

  queue.attach({ emit: () => {} })
  const snap = queue.snapshot()
  check(
    'queue.snapshot() 给出 items / running / limits',
    Array.isArray(snap.items) && Array.isArray(snap.running) && typeof snap.limits.maxConcurrent === 'number',
  )
  const applied = queue.setLimits({ maxConcurrent: 2, maxKBps: 0, connections: 4 })
  check('queue.setLimits 转发到台账', applied.ok && applied.limits.maxConcurrent === 2)

  /* 接线：preload / register / 右栏标签（通道清单本身由 134-ipc-channels 点名） */
  const preloadSrc = fs.readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  check(
    '★ preload 暴露了下载动作 + 事件订阅',
    preloadSrc.includes('downloadsList') &&
      preloadSrc.includes('onDownloadsEvent') &&
      preloadSrc.includes("'downloads:add'"),
    'preload 里没接上',
  )
  const regSrc = fs.readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8')
  check('★ register-handlers 装上了 handlers/downloads', regSrc.includes('handlers/downloads.cjs'))
  const tabsSrc = fs.readFileSync(join(ROOT, 'src/components/layout/RightTabs.tsx'), 'utf8')
  check('★ 右栏有「下载」标签', tabsSrc.includes("id: 'downloads'"))

  /* ★ 盘根不炸：父目录是盘根（E:\）时 mkdirSync 在 Windows 上抛 EPERM —— ensureDir
     得「已存在就跳过」。真跑一次盘根路径（2026-10-11 真机踩到）。 */
  const root = path.parse(process.cwd()).root
  const rootOk = (() => { try { engine.ensureDir(root); return true } catch { return false } })()
  check('★ 父目录是盘根时 ensureDir 不抛（mkdir EPERM 那道坑）', rootOk, `根=${root}`)

  /* 保存位置拆成「文件名 + 文件夹」两个框 —— 不许退回「一个框填完整路径」。 */
  const panelSrc = fs.readFileSync(join(ROOT, 'src/components/layout/DownloadsPanel.tsx'), 'utf8')
  const twoInputs =
    panelSrc.includes('aria-label="文件名"') && panelSrc.includes('aria-label="保存文件夹"')
  check('★ 下载面板有「文件名」与「保存文件夹」两个框（不再是一个框填完整路径）', twoInputs)

  /* 硬约束 9：限速默认值只能有一处真相源 —— 界面那份「兜底」必须与内核同值 */
  const apiSrc = fs.readFileSync(join(ROOT, 'src/lib/downloadsApi.ts'), 'utf8')
  const fallbackRaw = apiSrc.match(/FALLBACK_LIMITS[^=]*=\s*\{([^}]*)\}/)?.[1] ?? ''
  const fallbackGot = fallbackRaw.replace(/\s+/g, '')
  const fallbackWant = `maxConcurrent:${store.DEFAULT_LIMITS.maxConcurrent},maxKBps:${store.DEFAULT_LIMITS.maxKBps},connections:${store.DEFAULT_LIMITS.connections}`
  check(
    '★ 界面兜底限速与内核默认值一致（两处不能各写一套）',
    fallbackGot === fallbackWant,
    `界面=${fallbackGot} 内核=${fallbackWant}`,
  )

  /* 收工：把台账指回默认，别让后面的组读到本组造的条目 */
  store.setFilePathForTest('')
  try {
    fs.unlinkSync(ledger)
  } catch {
    /* 没有更好 */
  }

  clear()
}
