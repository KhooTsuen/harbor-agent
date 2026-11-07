import { join, mkdirSync, readFileSync, rmSync, require, ROOT, SANDBOX, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   迁移的**异步性与接线**（2026-11-07）

   和 222 组分家（那边管"校验对不对"，这边管"搬的时候会不会卡死、
   搬完谁来切指针"）。拆的理由是 222 加完超过 300 行红线，按语义切最省事。

   这一组钉四件事：
     ④ 纯缓存不复制（Chromium 自己在写它，搬过去必然半旧）
     ⑥ 复制大目录时**事件循环还在动** —— 异步性，不是"我说它异步"
     ⑦ 校验不过 / 目标非空 → 指针不切、旧数据不动
     ⑩ 接线：handler 真的 await 了异步内核（不 await 会返回 pending Promise）

   为什么 ⑥ 要用定时器来测：`fs.cpSync` 那种同步实现的特征是**独占事件循环**，
   1ms 定时器一次都跑不到。所以要证明异步，就得在场外看"别人还能不能动"——
   而不是读源码看有没有 await（那是**声明**，不是**行为**）。

   ⚠️ 全部在 SANDBOX 里造合成数据，不碰真数据。
   ══════════════════════════════════════════════════════════════ */

const copyCore = require(join(ROOT, 'electron/core/data-migrate-copy.cjs'))
const migrateCore = require(join(ROOT, 'electron/core/data-migrate.cjs'))
const verifyCore = require(join(ROOT, 'electron/core/data-migrate-verify.cjs'))
const fsp = require('node:fs/promises')
const nodePath = require('node:path')

/** 造一棵小树（这一组不关心大文件，只要够触发多次 yield） */
async function makeTree(root) {
  await fsp.mkdir(nodePath.join(root, 'sessions'), { recursive: true })
  await fsp.mkdir(nodePath.join(root, 'chromium', 'Cache'), { recursive: true })
  await fsp.mkdir(nodePath.join(root, 'chromium', 'Local Storage'), { recursive: true })
  await fsp.writeFile(nodePath.join(root, 'config.json'), '{"a":1}', 'utf8')
  await fsp.writeFile(nodePath.join(root, 'sessions', 'sess_a.jsonl'), '{"role":"user"}\n', 'utf8')
  await fsp.writeFile(nodePath.join(root, 'chromium', 'Cache', 'data_0'), 'cache', 'utf8')
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
  const dir = join(SANDBOX, 'migrate-async')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  try {
    /* ══ ④ 纯缓存不复制，用户数据照搬 ══════════════════════════ */
    group('迁移异步 / ④ 纯缓存不复制，Local Storage 照搬')
    const srcD = await makeTree(join(dir, 'd-src'))
    const dstD = join(dir, 'd-dst')
    const copied = await copyCore.copyTree({ from: srcD, to: dstD })

    check(
      '★★ chromium/Cache 没被复制（它是 Chromium 进程在写，搬过去必然半旧）',
      !exists(join(dstD, 'chromium', 'Cache', 'data_0')),
      exists(join(dstD, 'chromium', 'Cache', 'data_0')) ? '被复制了' : '没复制',
    )
    check(
      '★★ chromium/Local Storage 照搬（设置就存在里面，丢了这个用户设置全没了）',
      exists(join(dstD, 'chromium', 'Local Storage', 'leveldb.log')),
      exists(join(dstD, 'chromium', 'Local Storage', 'leveldb.log')) ? '在' : '丢了',
    )
    check('★ 跳过的计数如实报出来', copied.skipped >= 1, String(copied.skipped))
    check('★ 用户文件都复制了（config + 会话 + localStorage，缓存不算）', copied.files === 3, String(copied.files))

    /* 缓存不参与校验：源里缓存变了不该让迁移失败 */
    await fsp.writeFile(join(srcD, 'chromium', 'Cache', 'data_0'), 'cache-changed', 'utf8')
    const cachedIgnored = await verifyCore.verifyAll({ from: srcD, to: dstD })
    check('★★ 缓存变了不影响校验（它本来就不该被搬）', cachedIgnored.ok === true, String(cachedIgnored.error ?? 'ok'))

    /* ══ ⑥ 异步性：复制期间事件循环还在动 ═════════════════════ */
    group('迁移异步 / ⑥ 复制大目录时事件循环还在动（不是同步阻塞）')
    const srcG = join(dir, 'g-src')
    await fsp.mkdir(srcG, { recursive: true })
    /* 造 300 个小文件：够触发多次 yield（YIELD_EVERY=64） */
    for (let i = 0; i < 300; i += 1) {
      await fsp.writeFile(join(srcG, `f-${i}.txt`), `v${i}`, 'utf8')
    }
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 1)
    const copiedG = await copyCore.copyTree({ from: srcG, to: join(dir, 'g-dst') })
    clearInterval(timer)
    check('★ 300 个文件都复制了', copiedG.files === 300, String(copiedG.files))
    check(
      '★★ 复制期间定时器还能跑（证明事件循环没被独占 —— 旧 cpSync 这里会是 0）',
      ticks > 0,
      `定时器跑了 ${ticks} 次`,
    )

    /* 校验也一样：300 个文件逐个算 hash，中途不许独占 */
    let verifyTicks = 0
    const vTimer = setInterval(() => {
      verifyTicks += 1
    }, 1)
    const manyHash = await verifyCore.verifyAll({ from: srcG, to: join(dir, 'g-dst') })
    clearInterval(vTimer)
    check('★ 300 个文件全量校验通过', manyHash.ok === true, String(manyHash.error ?? 'ok'))
    check('★★ 校验期间事件循环也没被独占', verifyTicks > 0, `定时器跑了 ${verifyTicks} 次`)

    /* ══ ⑦ 校验不过 / 目标非空 → 指针不切 ═════════════════════ */
    group('迁移异步 / ⑦ 不该切指针的时候一个都不切')
    const srcH = await makeTree(join(dir, 'h-src'))
    const dstH = join(dir, 'h-dst')
    let switchedH = false
    await copyCore.copyTree({ from: srcH, to: dstH })
    await fsp.writeFile(join(dstH, 'sessions', 'sess_a.jsonl'), 'TAMPERED', 'utf8')
    const badH = await verifyCore.verifyAll({ from: srcH, to: dstH })
    check('★★ 被篡改的文件查得出来', badH.ok === false)
    check('★ 这时指针还是 false（没被切）', switchedH === false)

    /* 目标非空：整体拒绝，指针不切、旧数据一个字不动 */
    const refusedH = await migrateCore.migrate({
      root: join(dir, 'h-root'),
      from: srcH,
      to: dstH,
      switchPointer: () => {
        switchedH = true
        return { ok: true, file: 'x' }
      },
    })
    check('★★ 目标有东西 → 整体拒绝，指针不切', refusedH.ok === false && switchedH === false, String(refusedH.phase))
    check('★★ 拒绝时旧数据完整', exists(join(srcH, 'config.json')) && exists(join(srcH, 'sessions', 'sess_a.jsonl')))

    /* ══ ⑩ 接线：handler 必须 await ═══════════════════════════ */
    group('迁移异步 / ⑩ 接线：handler 等异步内核')
    const handlerSrc = readFileSync(join(ROOT, 'electron/handlers/data-location.cjs'), 'utf8')
    check(
      '★★ handler 用了 async 并 await 内核（不 await 会返回一个 pending Promise）',
      /dataLocation:migrate',\s*async/.test(handlerSrc) && /await\s+dataMigrate\.migrate\(/.test(handlerSrc),
    )
    check('★ 有「上一次还在跑」的并发闸', handlerSrc.includes('migrating'))
    check(
      '★ 抛异常也收成 ok:false（不把异常漏成未处理拒绝）',
      handlerSrc.includes('catch (error)') && handlerSrc.includes('finally'),
    )

    const coreSrc = readFileSync(join(ROOT, 'electron/core/data-migrate.cjs'), 'utf8')
    /* 只看非注释行 —— 文件头里写着「V1 用 fs.cpSync」是在解释为什么要改，不是还在用 */
    const coreCode = coreSrc
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    check(
      '★★ 内核不再用 cpSync（同步复制会卡死界面）',
      !coreCode.includes('cpSync'),
      coreCode.includes('cpSync') ? '代码里还在用' : '已移除（只剩注释里的历史说明）',
    )
    check('★ 用了逐文件异步复制', coreCode.includes('copy.copyTree'))
    check('★ 校验走全量那一份', coreCode.includes('verify.verifyAll'))
    check('★ 重拷轮数有上限（不是 while(true)）', coreCode.includes('REPAIR_ROUNDS'))
    check('★ 复制前后各拍一次快照（并发写入靠它发现）', coreCode.includes('copy.snapshot') && coreCode.includes('diffSnapshots'))
    check('★★ 内核里没有删源目录的动作', !/rmSync\(\s*src/.test(coreCode))
    check('★ 沿用旧状态机制（中断识别还在）', coreCode.includes('STATE_NAME') && coreCode.includes('resume'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
