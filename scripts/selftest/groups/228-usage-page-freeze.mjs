import { join, mkdirSync, readFileSync, rmSync, require, ROOT, SANDBOX, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   228 —— 「数据与用量」页冻结（2026-11-08）

   上一轮（469e293）修的是备份同步扫盘那 6 秒，这一轮是**剩下的那部分**。
   实测到的三处（Dev 真实数据，只读）：audit.stats(90) 1938 ms /
   session.list() 965 ms / task.list(200) 298 ms，合计 1985~3208 ms，
   **主进程整个冻死**（`Promise.all` 对同步函数没有并发效果）。

   修法：① audit-stats.cjs 流式 + 按行让出 + 按天缓存；
        ② data-port.cjs 只要数字的通道（数个数不需要读内容）；
        ③ handler / preload / 渲染层改 async 走新通道。

   这一组钉「不再冻住」这个**行为**（定时器还能跑），不是钉用了哪个函数；
   还钉数字口径 —— 计数必须与各 list 一致，差一个用户就会删错。
   ══════════════════════════════════════════════════════════════ */

/** 造一天的审计文件（n 条） */
function makeAuditDay(dir, day, n, okEvery = 3) {
  const lines = []
  for (let i = 0; i < n; i += 1) {
    lines.push(
      JSON.stringify({
        ts: Date.now(),
        sessionId: 's1',
        tool: i % 2 === 0 ? 'read_file' : 'run_shell',
        ok: i % okEvery !== 0,
        approval: i % 7 === 0 ? false : null,
      }),
    )
  }
  writeFileSync(join(dir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
}

/** 事件循环探针：看定时器还能不能跑 */
function lagProbe() {
  let max = 0
  let samples = 0
  let last = Date.now()
  let running = true
  const tick = () => {
    if (!running) return
    const now = Date.now()
    const gap = now - last - 5
    if (gap > max) max = gap
    last = now
    samples += 1
    setTimeout(tick, 5)
  }
  setTimeout(tick, 5)
  return {
    stop() {
      running = false
      return { max: Number(max.toFixed(1)), samples }
    },
  }
}

export async function run() {
  const paths = require(join(ROOT, 'electron/core/paths.cjs'))
  const auditCore = require(join(ROOT, 'electron/core/audit.cjs'))
  const auditStats = require(join(ROOT, 'electron/core/audit-stats.cjs'))
  const dataPort = require(join(ROOT, 'electron/core/data-port.cjs'))
  const auditDir = paths.DIRS.audit ?? join(paths.DIRS.data, 'audit')

  const madeRoot = join(SANDBOX, 'g228')
  rmSync(madeRoot, { recursive: true, force: true })
  mkdirSync(madeRoot, { recursive: true })
  mkdirSync(auditDir, { recursive: true })

  /* 记下原本有哪些审计天（跑完要还原，别污染别的组） */
  let original = []
  try {
    original = require('node:fs')
      .readdirSync(auditDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
  } catch {
    original = []
  }
  const created = []

  try {
    /* ══ ① 统计口径：异步版与同步版必须逐项一致 ═══════════════ */
    group('用量页冻结 / ① 异步统计的口径与同步版一致')

    /* 造 3 天、共 6 万条（约 6 MB）—— 必须跨多个 chunk 才能验证「让出事件循环」 */
    makeAuditDay(auditDir, '2030-01-01', 22000)
    makeAuditDay(auditDir, '2030-01-02', 20000)
    makeAuditDay(auditDir, '2030-01-03', 18000)
    created.push('2030-01-01', '2030-01-02', '2030-01-03')

    const sync = auditCore.stats(90)
    const async_ = await auditStats.statsAsync(90)
    check('★★ 总条数一致', sync.total === async_.total, `${sync.total} vs ${async_.total}`)
    check('★ 失败数一致', sync.failed === async_.failed, `${sync.failed} vs ${async_.failed}`)
    check('★ 被拒数一致', sync.denied === async_.denied, `${sync.denied} vs ${async_.denied}`)
    check('★ 天数一致', sync.days === async_.days, `${sync.days} vs ${async_.days}`)
    check(
      '★★ 按工具的分布逐项一致（不是只对总数）',
      Object.keys(sync.byTool).length === Object.keys(async_.byTool).length &&
        Object.entries(sync.byTool).every(([k, v]) => async_.byTool[k] === v),
      `${JSON.stringify(sync.byTool)} vs ${JSON.stringify(async_.byTool)}`,
    )
    check('★ 确实造出了数据（否则上面几条是空对空）', sync.total >= 60000, String(sync.total))

    /* ══ ② 不再冻住：定时器全程能跑 ═══════════════════════════ */
    group('用量页冻结 / ② 统计期间事件循环仍在转（这是这一轮的正题）')
    {
      /* 对照组：探针本身在工作吗（单靠一个 50ms 的 await 就该有 ~10 次采样） */
      const sanity = lagProbe()
      await new Promise((r) => setTimeout(r, 50))
      const sanityLag = sanity.stop()
      check('★ 对照：探针本身能采样（否则下面的 0 次说明探针坏了）', sanityLag.samples >= 3, `采样 ${sanityLag.samples} 次`)

      /*
       * 逼它走冷路径：**内存和磁盘都得清**。
       * 只删磁盘文件是不够的 —— 内存里 `dayCache` 还在，3 ms 就返回了，
       * 测出来的是热路径（这一条是实测踩出来的，不是防患于未然）。
       */
      auditStats.resetCache()
      rmSync(join(auditDir, auditStats.CACHE_NAME), { force: true })
      const probe = lagProbe()
      const started = Date.now()
      await auditStats.statsAsync(90)
      const took = Date.now() - started
      const lag = probe.stop()
      check(
        '★ 定时器在统计期间跑了不止一两次（同步版这里会是 0）',
        lag.samples >= 3,
        `采样 ${lag.samples} 次 / 耗时 ${took} ms / 最长停顿 ${lag.max} ms`,
      )
      check('★★ 单次事件循环停顿 < 100ms', lag.max < 100, `${lag.max} ms`)
      check('★ 报出了实际耗时（人能核对是不是真的读了）', took >= 0, `${took} ms`)
    }

    /* ══ ③ 按天缓存：第二次不重读 ═════════════════════════════ */
    group('用量页冻结 / ③ 按天缓存（过去那几天不再变，不必重读）')
    const first = await auditStats.statsAsync(90)
    const second = await auditStats.statsAsync(90)
    check('★★ 第二次全部命中缓存', (second.cached ?? 0) === second.days && second.days > 0, `命中 ${second.cached}/${second.days}`)
    check('★★ 命中缓存时数字不变（缓存不许改数）', second.total === first.total, `${first.total} vs ${second.total}`)
    {
      const probe = lagProbe()
      const started = Date.now()
      await auditStats.statsAsync(90)
      const took = Date.now() - started
      probe.stop()
      check('★★ 热路径 < 100ms（没命中时会是一两秒）', took < 100, `${took} ms`)
    }
    check(
      '★ 缓存文件写出来了（重启后也能命中）',
      (() => {
        try {
          return require('node:fs').statSync(join(auditDir, auditStats.CACHE_NAME)).size > 0
        } catch {
          return false
        }
      })(),
    )

    /* ══ ④ 文件变了就重算（缓存不许给过期数字）════════════════ */
    group('用量页冻结 / ④ 文件变了就重算（缓存不许给过期数字）')
    const beforeAppend = await auditStats.statsAsync(90)
    /* 往今天那个文件追加 5 条 */
    const target = join(auditDir, '2030-01-03.jsonl')
    const more = []
    for (let i = 0; i < 5; i += 1) more.push(JSON.stringify({ ts: Date.now(), tool: 'write_file', ok: true }))
    writeFileSync(target, `${require('node:fs').readFileSync(target, 'utf8')}${more.join('\n')}\n`, 'utf8')

    const afterAppend = await auditStats.statsAsync(90)
    check('★★ 追加后条数变了（缓存没挡住）', afterAppend.total === beforeAppend.total + 5, `${beforeAppend.total} → ${afterAppend.total}`)
    /* 用**增量**判据：byTool 是所有天的合计，别的组也会写审计（第一版写成 ===5 直接红了） */
    const beforeWf = beforeAppend.byTool.write_file ?? 0
    const afterWf = afterAppend.byTool.write_file ?? 0
    check('★ 新工具在分布里 +5', afterWf === beforeWf + 5, `${beforeWf} → ${afterWf}`)
    check('★ 没变的那几天仍命中缓存（只重算变的那天）', (afterAppend.cached ?? 0) >= 1, `命中 ${afterAppend.cached}`)

    /* ══ ⑤ 计数通道：与各 list 的数字一致 ════════════════════ */
    group('用量页冻结 / ⑤ 计数口径（差一个用户就会删错）')
    const sessionCore = require(join(ROOT, 'electron/core/session.cjs'))
    const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
    const memoryCore = require(join(ROOT, 'electron/core/memory.cjs'))
    const skillsCore = require(join(ROOT, 'electron/core/skills.cjs'))
    const counts = dataPort.counts()

    check(
      '★★ 会话数 = session.list().length',
      counts.sessions === sessionCore.list().length,
      `${counts.sessions} vs ${sessionCore.list().length}`,
    )
    check(
      '★★ 任务数 = task.list({limit:200}).length',
      counts.tasks === taskCore.list({ limit: 200 }).length,
      `${counts.tasks} vs ${taskCore.list({ limit: 200 }).length}`,
    )
    check(
      '★ 记忆数 = memory.list().length',
      counts.memory === memoryCore.list({ includeSuperseded: true }).length,
      `${counts.memory}`,
    )
    check('★ 技能数 = skills.list().length', counts.skills === skillsCore.list().length, `${counts.skills}`)

    /* ══ ⑥ 计数不读正文（这才是它快的根本原因）════════════════ */
    group('用量页冻结 / ⑥ 计数不读正文')
    {
      const probe = lagProbe()
      const started = Date.now()
      dataPort.counts()
      const took = Date.now() - started
      const lag = probe.stop()
      check('★★ 计数 < 50ms（读正文的话是几百到上千毫秒）', took < 50, `${took} ms`)
      check('★ 计数期间没有长停顿', lag.max < 50, `${lag.max} ms`)
    }
    check(
      '★★ data-port.cjs 里没有整篇 readFileSync（数个数不该读内容）',
      (() => {
        const src = readFileSync(join(ROOT, 'electron/core/data-port.cjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
        return !/readFileSync/.test(src)
      })(),
    )
    check(
      '★ 但确实 statSync 了（空文件不算一条会话 —— 判据要和 list 一致）',
      readFileSync(join(ROOT, 'electron/core/data-port.cjs'), 'utf8').includes('statSync'),
    )

    /* ══ ⑦ 接线：IPC 走异步版，不再用同步 stats ═══════════════ */
    group('用量页冻结 / ⑦ 接线（handler 必须 await，否则冻结照旧）')
    const safetySrc = readFileSync(join(ROOT, 'electron/handlers/safety.cjs'), 'utf8')
    check('★★ audit:stats 调的是 statsAsync', /audit\.statsAsync\(/.test(safetySrc))
    check('★★ audit:stats 是 async handler（不 await 会返回 pending Promise）', /ipcMain\.handle\('audit:stats',\s*async/.test(safetySrc))
    check(
      '★★ 没有残留同步调用 audit.stats(',
      !/audit\.stats\((?!Async)/.test(safetySrc.replace(/audit\.statsAsync\(/g, '')),
    )
    check('★★ dataPort:count 通道注册了', /ipcMain\.handle\('dataPort:count'/.test(safetySrc))
    check(
      '★ 通道进了 EXPECTED_CHANNELS（漏了打包自检报 channelsMissing）',
      readFileSync(join(ROOT, 'electron/ipc-channels.cjs'), 'utf8').includes("'dataPort:count'"),
    )
    check(
      '★ preload 也桥接了',
      readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8').includes('dataPortCount'),
    )

    /* ══ ⑧ 渲染层不再用 5 个完整接口取 length ════════════════ */
    group('用量页冻结 / ⑧ 渲染层只拿数字')
    const exportSrc = readFileSync(join(ROOT, 'src/lib/dataPortExport.ts'), 'utf8')
    check(
      '★★ countData 走的是 dataPortCount',
      /export async function countData\(\)[\s\S]{0,400}dataPortCount\(\)/.test(exportSrc),
    )
    check(
      '★★ countData 里不再有 Promise.all 那五个完整接口',
      (() => {
        const at = exportSrc.indexOf('export async function countData')
        if (at < 0) return false
        const body = exportSrc.slice(at, at + 500)
        return !/Promise\.all/.test(body)
      })(),
    )

    /* ══ ⑨ 估算/旧口径没被这次改动碰 ═════════════════════════ */
    group('用量页冻结 / ⑨ 没顺手改掉不该动的')
    check(
      '★ audit.cjs 仍导出同步 stats（脚本与老调用方还在用）',
      /statsAsync/.test(readFileSync(join(ROOT, 'electron/core/audit.cjs'), 'utf8')) &&
        /module\.exports\s*=\s*\{[^}]*\bstats\b/.test(readFileSync(join(ROOT, 'electron/core/audit.cjs'), 'utf8')),
    )
    check(
      '★ stats.cjs（旧用量累计）没被删',
      (() => {
        try {
          return require('node:fs').existsSync(join(ROOT, 'electron/core/stats.cjs'))
        } catch {
          return false
        }
      })(),
    )
  } finally {
    /* 还原现场：删掉本组造的审计天与缓存 */
    for (const day of created) {
      try {
        rmSync(join(auditDir, `${day}.jsonl`), { force: true })
      } catch {
        /* 清不掉就算了 */
      }
    }
    try {
      rmSync(join(auditDir, auditStats.CACHE_NAME), { force: true })
    } catch {
      /* 同上 */
    }
    rmSync(madeRoot, { recursive: true, force: true })
  }
}
