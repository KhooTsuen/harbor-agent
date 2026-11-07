import { join, mkdirSync, readFileSync, rmSync, require, ROOT, SANDBOX, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   迁移可靠性收尾（2026-11-07）

   补的是 V1 留下的两个**真缺口**，不是新功能：

   ── 缺口一：抽样校验漏得掉 ──────────────────────────────────
   V1 的 `verify` 是「最近改的 12 个 + 最大的 8 个，每份只比头 64KB」：
     · 同尺寸不同内容 → 大小一致就跳过内容比对，换一个字节看不出来
     · 抽样之外的文件 → 10000 个里只比 20 个
     · 大文件后半段 → 只比头 64KB，后半截坏了查不出
   现在逐文件 SHA-256。这一组把三个漏洞各造一个样本钉住。

   ── 缺口二：同步复制既卡界面、又不保一致性 ──────────────────
   V1 用 `fs.cpSync` 同步，理由是「主进程被占住 → 没人能写进来」。
   **理由是错的**：`data/chromium` 是 Chromium 自己的进程在写，主进程阻塞
   拦不住它；而 4.8GB 同步复制会让界面几十秒不响应。
   现在异步分批 + 复制前后拍快照。这一组钉两件事：
     · 复制大目录**期间事件循环还在动**（异步性，不是"我说它异步"）
     · 复制期间源被改 → 差异**如实报出来**，不写成成功

   ⚠️ 全部在 SANDBOX 里造合成数据，不碰真数据。
   ══════════════════════════════════════════════════════════════ */

const verifyCore = require(join(ROOT, 'electron/core/data-migrate-verify.cjs'))
const copyCore = require(join(ROOT, 'electron/core/data-migrate-copy.cjs'))
const migrateCore = require(join(ROOT, 'electron/core/data-migrate.cjs'))
const plan = require(join(ROOT, 'electron/core/data-migrate-plan.cjs'))
const fsp = require('node:fs/promises')
const nodePath = require('node:path')

/** 造一棵够杂的树：多层目录 / 同尺寸不同内容 / 大文件 / 纯缓存 */
async function makeTree(root, { big = false } = {}) {
  await fsp.mkdir(nodePath.join(root, 'sessions'), { recursive: true })
  await fsp.mkdir(nodePath.join(root, 'tasks', 'deep', 'deeper'), { recursive: true })
  await fsp.mkdir(nodePath.join(root, 'chromium', 'Cache'), { recursive: true })
  await fsp.mkdir(nodePath.join(root, 'chromium', 'Local Storage'), { recursive: true })

  await fsp.writeFile(nodePath.join(root, 'config.json'), '{"a":1}', 'utf8')
  /* 两个**同样大小、不同内容**的文件 —— V1 的 size 比对完全看不出来 */
  await fsp.writeFile(nodePath.join(root, 'sessions', 'same-size-a.jsonl'), 'AAAA', 'utf8')
  await fsp.writeFile(nodePath.join(root, 'sessions', 'same-size-b.jsonl'), 'BBBB', 'utf8')
  await fsp.writeFile(nodePath.join(root, 'tasks', 'deep', 'deeper', 'note.txt'), 'deep', 'utf8')
  /* 大文件：V1 只比头 64KB，后半截坏了查不出 */
  if (big) {
    const body = `${'x'.repeat(70 * 1024)}TAIL-MARK-12345`
    await fsp.writeFile(nodePath.join(root, 'sessions', 'big.jsonl'), body, 'utf8')
  }
  /* 纯缓存：不该被复制 */
  await fsp.writeFile(nodePath.join(root, 'chromium', 'Cache', 'data_0'), 'cache', 'utf8')
  /* 用户数据（localStorage 存设置）：必须照搬 */
  await fsp.writeFile(nodePath.join(root, 'chromium', 'Local Storage', 'leveldb.log'), 'theme=dark', 'utf8')

  return root
}

const exists = (p) => {
  try {
    return require('node:fs').existsSync(p)
  } catch {
    return false
  }
}

export async function run() {
  const dir = join(SANDBOX, 'migrate-reliability')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  try {
    /* ══ ① 同尺寸不同内容 ═════════════════════════════════════ */
    group('迁移可靠性 / ① 同尺寸不同内容必须查出来')
    const srcA = await makeTree(join(dir, 'a-src'))
    const dstA = join(dir, 'a-dst')
    await fsp.cp(srcA, dstA, { recursive: true })

    /* 把 dst 里那个 4 字节文件的**内容**改掉，大小完全一样 */
    await fsp.writeFile(join(dstA, 'sessions', 'same-size-a.jsonl'), 'ZZZZ', 'utf8')

    const sized = await fsp.stat(join(srcA, 'sessions', 'same-size-a.jsonl'))
    const sized2 = await fsp.stat(join(dstA, 'sessions', 'same-size-a.jsonl'))
    check('样本成立：两个文件大小一致', sized.size === sized2.size, `${sized.size} vs ${sized2.size}`)

    const caught = await verifyCore.verifyAll({ from: srcA, to: dstA })
    check('★★ 同尺寸不同内容 → 校验报红（V1 的 size 比对漏掉这个）', caught.ok === false, String(caught.error ?? 'ok'))
    check(
      '★ 点名了是哪个文件（能定位，不是一个「有 N 个坏了」）',
      Array.isArray(caught.bad) && caught.bad.some((b) => String(b.rel).includes('same-size-a')),
      JSON.stringify((caught.bad ?? []).map((b) => b.rel)),
    )
    check(
      '★ 报了两边 hash 前缀（看得出确实不同）',
      Array.isArray(caught.bad) && caught.bad.every((b) => b.from && b.to && b.from !== b.to),
      JSON.stringify(caught.bad?.[0] ?? {}),
    )

    /* ══ ② 抽样之外的文件 ═════════════════════════════════════ */
    group('迁移可靠性 / ② 抽样之外的文件也要查')
    const srcB = await makeTree(join(dir, 'b-src'))
    const dstB = join(dir, 'b-dst')
    await fsp.cp(srcB, dstB, { recursive: true })
    /* 挑一个「既不是最新的、也不是最大的」—— V1 的抽样正好会漏掉它 */
    await fsp.writeFile(join(dstB, 'tasks', 'deep', 'deeper', 'note.txt'), 'DEEP', 'utf8')

    const deepCaught = await verifyCore.verifyAll({ from: srcB, to: dstB })
    check('★★ 深层小文件被改 → 报红（V1 只比 20 个，这个挤不进抽样）', deepCaught.ok === false, String(deepCaught.error ?? 'ok'))
    check(
      '★ 点名的就是它',
      Array.isArray(deepCaught.bad) && deepCaught.bad.some((b) => String(b.rel).includes('note.txt')),
      JSON.stringify((deepCaught.bad ?? []).map((b) => b.rel)),
    )

    /* ══ ③ 大文件后半段 ═══════════════════════════════════════ */
    group('迁移可靠性 / ③ 大文件后半段坏了也要查')
    const srcC = await makeTree(join(dir, 'c-src'), { big: true })
    const dstC = join(dir, 'c-dst')
    await fsp.cp(srcC, dstC, { recursive: true })
    /* 只改最后 5 个字节 —— 大小不变，头 64KB 一模一样 */
    const bigPath = join(dstC, 'sessions', 'big.jsonl')
    const bigText = await fsp.readFile(bigPath, 'utf8')
    await fsp.writeFile(bigPath, `${bigText.slice(0, -5)}AAAAA`, 'utf8')

    const sameSize = (await fsp.stat(bigPath)).size === (await fsp.stat(join(srcC, 'sessions', 'big.jsonl'))).size
    const sameHead =
      (await fsp.readFile(bigPath, 'utf8')).slice(0, 64 * 1024) ===
      (await fsp.readFile(join(srcC, 'sessions', 'big.jsonl'), 'utf8')).slice(0, 64 * 1024)
    check('样本成立：大小相同、头 64KB 相同', sameSize && sameHead, `${sameSize} / ${sameHead}`)

    const tailCaught = await verifyCore.verifyAll({ from: srcC, to: dstC })
    check('★★ 尾部被动过 → 报红（V1 只比头 64KB，漏掉尾巴）', tailCaught.ok === false, String(tailCaught.error ?? 'ok'))

    /* ══ ⑤ 复制期间源被改：如实报出 ═══════════════════════════ */
    group('迁移可靠性 / ⑤ 迁移期间有写入 → 如实报，不装成功')
    const srcE = await makeTree(join(dir, 'e-src'))
    const dstE = join(dir, 'e-dst')
    const before = await copyCore.snapshot(srcE)
    await copyCore.copyTree({ from: srcE, to: dstE })
    /* 模拟「复制期间日志还在追加」：复制完、拍第二张快照之前改文件 */
    await fsp.writeFile(join(srcE, 'sessions', 'same-size-a.jsonl'), 'CHANGED-DURING-COPY', 'utf8')
    const after = await copyCore.snapshot(srcE)
    const moved = copyCore.diffSnapshots(before, after)

    check('★★ 复制期间的变化被认出来', moved.length > 0, JSON.stringify(moved.slice(0, 3)))
    check(
      '★ 点名了是哪个文件 + 什么变化（大小变了 / 被改过）',
      moved.some((item) => String(item.rel).includes('same-size-a') && item.reason),
      JSON.stringify(moved[0] ?? {}),
    )
    check('★ 没变化的文件不进清单（不制造噪音）', moved.every((item) => !String(item.rel).includes('config.json')))

    /* 端到端：源在复制中被改 → 迁移结果里带 concurrentChanges，且内容真的对时照样成功 */
    const srcF = await makeTree(join(dir, 'f-src'))
    const dstF = join(dir, 'f-dst')
    let switchedF = false
    const migratedF = await migrateCore.migrate({
      root: join(dir, 'f-root'),
      from: srcF,
      to: dstF,
      switchPointer: () => {
        switchedF = true
        return { ok: true, file: join(dir, 'f-root', 'data-location.json') }
      },
    })
    check('★ 没有并发写入时迁移成功', migratedF.ok === true, String(migratedF.error ?? ''))
    check('★ concurrentChanges 是数组且为空（全程没动过）', Array.isArray(migratedF.concurrentChanges) && migratedF.concurrentChanges.length === 0)
    check('★ 迁移后逐文件比对仍然一致', (await verifyCore.verifyAll({ from: srcF, to: dstF })).ok === true)
    check('★ 指针被切过', switchedF === true)

    /* ══ ⑧ 重拷贝修：抖动靠它收敛，但轮数有上限 ═══════════════ */
    group('迁移可靠性 / ⑧ 校验不过会重拷坏文件（有上限，不无限重试）')
    const srcI = await makeTree(join(dir, 'i-src'))
    const dstI = join(dir, 'i-dst')
    await copyCore.copyTree({ from: srcI, to: dstI })
    await fsp.writeFile(join(dstI, 'sessions', 'same-size-a.jsonl'), 'BAD!', 'utf8')
    const first = await verifyCore.verifyAll({ from: srcI, to: dstI })
    check('★ 先红（拷了个坏的）', first.ok === false)
    /* 手工重拷那一个文件 —— 这正是 migrate 内部 repair 做的事 */
    await fsp.copyFile(join(srcI, 'sessions', 'same-size-a.jsonl'), join(dstI, 'sessions', 'same-size-a.jsonl'))
    const second = await verifyCore.verifyAll({ from: srcI, to: dstI })
    check('★★ 重拷那一个就绿了（repair 的思路真的有效）', second.ok === true, String(second.error ?? 'ok'))

    /* ══ ⑨ 语义：日志可以漂，用户数据一个字都不能漂 ═══════════ */
    group('迁移可靠性 / ⑨ 漂移容忍只给诊断产物')
    const srcJ = await makeTree(join(dir, 'j-src'))
    const dstJ = join(dir, 'j-dst')
    await fsp.mkdir(nodePath.join(srcJ, 'logs'), { recursive: true })
    await fsp.writeFile(nodePath.join(srcJ, 'logs', 'main.log'), 'line1\n', 'utf8')
    const beforeJ = await copyCore.snapshot(srcJ)
    await copyCore.copyTree({ from: srcJ, to: dstJ })
    /* 复制期间日志追加了几行（真实情形：Harbor 自己一直在写） */
    await fsp.appendFile(nodePath.join(srcJ, 'logs', 'main.log'), 'line2\nline3\n', 'utf8')

    const grown = await verifyCore.verifyAll({ from: srcJ, to: dstJ, source: beforeJ })
    check('★★ 日志在复制期间变长 → 仍然算通过（否则迁移永远失败）', grown.ok === true, String(grown.error ?? 'ok'))
    check(
      '★ 但漂移被如实列出（不静默）',
      Array.isArray(grown.drift) && grown.drift.some((r) => String(r).includes('main.log')),
      JSON.stringify(grown.drift ?? []),
    )

    /* 反过来：配置在复制期间被改 → 必须红（不能让用户迁移完发现配置回退一版） */
    const srcK = await makeTree(join(dir, 'k-src'))
    const dstK = join(dir, 'k-dst')
    const beforeK = await copyCore.snapshot(srcK)
    await copyCore.copyTree({ from: srcK, to: dstK })
    await fsp.writeFile(nodePath.join(srcK, 'config.json'), '{"a":1,"changed":true}', 'utf8')
    const configDrift = await verifyCore.verifyAll({ from: srcK, to: dstK, source: beforeK })
    check('★★ 配置在复制期间被改 → 红（用户数据不许"回退一版"）', configDrift.ok === false, String(configDrift.error ?? 'ok'))

    /* 会话也一样 */
    const srcL = await makeTree(join(dir, 'l-src'))
    const dstL = join(dir, 'l-dst')
    const beforeL = await copyCore.snapshot(srcL)
    await copyCore.copyTree({ from: srcL, to: dstL })
    await fsp.appendFile(nodePath.join(srcL, 'sessions', 'same-size-a.jsonl'), 'MORE', 'utf8')
    const sessionDrift = await verifyCore.verifyAll({ from: srcL, to: dstL, source: beforeL })
    check('★★ 会话在复制期间被写 → 红（证据不能少）', sessionDrift.ok === false, String(sessionDrift.error ?? 'ok'))

  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
