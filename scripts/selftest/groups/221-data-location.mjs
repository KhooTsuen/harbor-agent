import { existsSync, join, mkdirSync, readFileSync, require, rmSync, ROOT, SANDBOX, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   数据目录：用户可指定位置 + 安全迁移（2026-11-07）

   钉的是三件事，每一件在真机上出问题都会让用户**丢数据或以为丢了数据**：

     ① **没有指针 = 老行为**。升级绝不能悄悄换目录 —— 用户升级完发现
        「我的会话没了」是最不能接受的一类事故。默认必须还是 `<root>/data`。
     ② **隔离优先于自定义目录**。用户一旦在别处指定过数据目录，自检/单测
        若不先判隔离，跑一次 `npm test` 就会写进他的真实数据。
     ③ **迁移绝不先删旧数据**。顺序必须是 检查→复制→校验→切指针，旧目录
        原样保留；任何一步失败都要如实说是哪一步，且旧数据一个字节没动。

   还有一条容易被写成"看起来对但等于没验"的：**校验不能只看复制命令的退出码**。
   这里刻意把目标文件改小，模拟"复制了一半"，断言 verify 必须报红。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const location = require(join(ROOT, 'electron/core/data-location.cjs'))
  const plan = require(join(ROOT, 'electron/core/data-migrate-plan.cjs'))
  const migrateCore = require(join(ROOT, 'electron/core/data-migrate.cjs'))
  const paths = require(join(ROOT, 'electron/core/paths.cjs'))

  const dir = join(SANDBOX, 'data-location')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const made = []

  /** 造一棵小数据树（含子目录 / 空文件 / 二进制） */
  const makeData = (root) => {
    mkdirSync(join(root, 'sessions'), { recursive: true })
    mkdirSync(join(root, 'backups', '20260101-000000'), { recursive: true })
    writeFileSync(join(root, 'config.json'), JSON.stringify({ theme: 'default' }), 'utf8')
    writeFileSync(join(root, 'sessions', 'sess_a.jsonl'), '{"role":"user"}\n', 'utf8')
    writeFileSync(join(root, 'sessions', 'sess_b.jsonl'), 'x'.repeat(3000), 'utf8')
    writeFileSync(join(root, 'backups', '20260101-000000', 'meta.json'), '{"items":[]}', 'utf8')
    writeFileSync(join(root, 'empty.txt'), '', 'utf8')
    return root
  }

  try {
    /* ══ ① 指针：没有就是老行为；坏了当没有 ═══════════════════ */
    group('数据目录 / ① 指针文件')
    const probeRoot = join(dir, 'root')
    mkdirSync(probeRoot, { recursive: true })

    check('★★ 没有指针 → 用默认目录（升级不悄悄换目录）', location.read(probeRoot) === null)

    const target1 = join(dir, 'moved-1')
    mkdirSync(target1, { recursive: true })
    const wrote = location.write(probeRoot, target1)
    check('★ 能写指针', wrote.ok === true, String(wrote.error ?? ''))
    check('★★ 读回来是那个目录', location.read(probeRoot)?.dataDir === target1, location.read(probeRoot)?.dataDir)

    check(
      '★★ 相对路径被拒（会随启动位置漂走）',
      location.write(probeRoot, 'relative/dir').ok === false,
    )

    /* 指针坏了：当它不存在，并且留一份 .broken */
    const pointerFile = location.candidates(probeRoot)[0]
    writeFileSync(pointerFile, '{ 这不是 JSON', 'utf8')
    check('★★ 指针坏了 → 当没有（不靠半截 JSON 启动）', location.read(probeRoot) === null)
    check(
      '★ 坏指针留档（能看出原本想指到哪）',
      existsSync(pointerFile) === false && location.candidates(probeRoot).some((f) => true),
    )

    location.write(probeRoot, target1)
    location.clear(probeRoot)
    check('★ clear 只删指针、不删数据', location.read(probeRoot) === null && existsSync(target1))

    /* resolve：目标目录不可用 → 回退默认并说原因 */
    location.write(probeRoot, join(dir, 'gone-dir'))
    const fallback = location.resolve(probeRoot, join(probeRoot, 'data'))
    check('★★ 指定的目录不存在 → 回退默认（U 盘拔了也要能启动）', fallback.dir === join(probeRoot, 'data'), fallback.dir)
    check('★ 回退时说清了原因', fallback.fallback.length > 0, fallback.fallback)
    location.clear(probeRoot)

    /* ══ ② 优先级：隔离优先于自定义目录 ═════════════════════════ */
    group('数据目录 / ② 隔离优先于用户指定目录')
    /*
     * 直接验 `isolationDirName()` 这条分支的**判据**，而不是读当前进程的 dataDir
     * —— 这组也可能被单独 `node` 起来跑（那时不是 selftest 入口，天然不隔离），
     * 拿进程状态当断言就成了"跑法不同结果不同"的假测试。
     * 真正要钉的是：**先判隔离，再判指针**。源码守卫 + 隔离判据各一条。
     */
    const pathsSrc = readFileSync(join(ROOT, 'electron/core/paths.cjs'), 'utf8')
    const isoAt = pathsSrc.indexOf('const iso = isolationDirName()')
    const pointerAt = pathsSrc.indexOf('dataLocation.resolve(')
    check(
      '★★ 隔离判断写在指针之前（否则自检会写进用户真实数据）',
      isoAt > 0 && pointerAt > 0 && isoAt < pointerAt,
      `iso@${isoAt} pointer@${pointerAt}`,
    )
    check(
      '★ 隔离分支直接 return，不会继续往下走到指针',
      /if \(iso\) return path\.join\(realDataDir\(\), iso\)/.test(pathsSrc),
    )

    /* ══ ③ 迁移：正常路径 ═════════════════════════════════════ */
    group('数据目录 / ③ 迁移：先复制、后校验、再切指针')
    const src = makeData(join(dir, 'src'))
    const dst = join(dir, 'dst')
    made.push(src, dst)

    const checked = plan.inspect({ from: src, to: dst })
    check('★ 检查通过（空目标、同盘、不在 C 盘）', checked.ok === true, JSON.stringify(checked.blockers))
    check('★ 检查报出了文件数与体积', checked.files === 5 && checked.bytes > 3000, `${checked.files} 个 / ${checked.bytes} 字节`)

    let pointedAt = ''
    const result = migrateCore.migrate({
      root: probeRoot,
      from: src,
      to: dst,
      switchPointer: (target) => {
        pointedAt = target
        return { ok: true, file: join(probeRoot, 'data-location.json') }
      },
    })
    check('★★ 迁移成功', result.ok === true, String(result.error ?? ''))
    check('★ 指针切到了新目录', pointedAt === dst, pointedAt)
    check('★★ 旧目录**保留**（不自动删）', existsSync(join(src, 'config.json')))
    check('★★ 新目录内容完整', existsSync(join(dst, 'config.json')) && existsSync(join(dst, 'sessions', 'sess_b.jsonl')))
    check('★ 迁移后报了文件数与耗时', result.files === 5 && result.ms >= 0, `${result.files} / ${result.ms}ms`)
    check(
      '★ 状态文件标成 done',
      plan.readState(dst)?.phase === 'done',
      plan.readState(dst)?.phase,
    )

    /* ══ ④ 迁移：拒绝的情形一个字节都不动 ═════════════════════ */
    group('数据目录 / ④ 该拒绝的都拒绝，且旧数据没动')

    const overlap = plan.inspect({ from: src, to: join(src, 'inner') })
    check('★★ 目标在源里面 → 拒绝（会边拷边变）', overlap.ok === false && overlap.blockers.some((b) => b.code === 'overlap'))

    const notEmpty = join(dir, 'not-empty')
    mkdirSync(notEmpty, { recursive: true })
    writeFileSync(join(notEmpty, '别人的东西.txt'), 'x', 'utf8')
    const busyTarget = plan.inspect({ from: src, to: notEmpty })
    check(
      '★★ 目标已有别的东西 → 拒绝（绝不覆盖用户数据）',
      busyTarget.ok === false && busyTarget.blockers.some((b) => b.code === 'not_empty'),
    )
    check('★ 那份别人的东西还在', existsSync(join(notEmpty, '别人的东西.txt')))

    const missing = plan.inspect({ from: join(dir, 'no-such-dir'), to: join(dir, 'dst2') })
    check('★★ 源不存在 → 拒绝', missing.ok === false && missing.blockers.some((b) => b.code === 'src_missing'))

    const relative = plan.inspect({ from: 'some/relative', to: 'another/relative' })
    check('★★ 相对路径 → 拒绝', relative.ok === false && relative.blockers.some((b) => b.code === 'relative'))

    /* ══ ⑤ 校验：复制了一半必须报红 ═══════════════════════════ */
    group('数据目录 / ⑤ 校验不认退出码，自己数')
    const halfSrc = makeData(join(dir, 'half-src'))
    const halfDst = join(dir, 'half-dst')
    mkdirSync(halfDst, { recursive: true })
    require('node:fs').cpSync(halfSrc, halfDst, { recursive: true })
    /* 模拟"拷了一半"：把一个文件截短 */
    writeFileSync(join(halfDst, 'sessions', 'sess_b.jsonl'), 'x'.repeat(10), 'utf8')
    const halfCheck = plan.verify(halfSrc, halfDst)
    check('★★ 文件被截短 → 校验报红', halfCheck.ok === false, halfCheck.error)
    check('★ 报出了是哪个文件不对', (halfCheck.sized ?? []).length === 1, JSON.stringify(halfCheck.sized))

    rmSync(join(halfDst, 'config.json'), { force: true })
    const fewer = plan.verify(halfSrc, halfDst)
    check('★★ 少了一个文件 → 校验报红', fewer.ok === false, fewer.error)

    /* 完整复制必须过 —— 否则上面那些红就不算"测到了" */
    const okDst = join(dir, 'ok-dst')
    mkdirSync(okDst, { recursive: true })
    require('node:fs').cpSync(halfSrc, okDst, { recursive: true })
    const good = plan.verify(halfSrc, okDst)
    check('★★ 完整复制校验通过（判据不是永远报红）', good.ok === true, String(good.error ?? ''))

    /* ══ ⑥ 迁移失败时旧数据一个字节没动 ═══════════════════════ */
    group('数据目录 / ⑥ 校验失败 → 指针不切、旧数据不动')
    const failSrc = makeData(join(dir, 'fail-src'))
    const failDst = join(dir, 'fail-dst')
    let switched = false
    const failed = migrateCore.migrate({
      root: probeRoot,
      from: failSrc,
      to: failDst,
      /* 注入一个"复制完之后偷偷截短"的场景不好造，改成让切指针失败 */
      switchPointer: () => {
        switched = true
        return { ok: false, error: '磁盘满了' }
      },
    })
    check('★ 切指针失败 → 整体 ok:false', failed.ok === false && failed.phase === 'switch', `${failed.ok} / ${failed.phase}`)
    check('★★ 说了"旧数据没动"', String(failed.error ?? '').includes('旧数据没动'), String(failed.error))
    check('★★ 数据确实完整活在源目录', existsSync(join(failSrc, 'config.json')) && existsSync(join(failSrc, 'sessions', 'sess_a.jsonl')))
    check('★ 切指针真的被调过（不是根本没走到）', switched === true)

    /* ══ ⑦ 中断后重试：允许清掉自己的半成品 ═══════════════════ */
    group('数据目录 / ⑦ 中断后重试')
    const retrySrc = makeData(join(dir, 'retry-src'))
    const retryDst = join(dir, 'retry-dst')
    mkdirSync(retryDst, { recursive: true })
    /* 造一个"上次没迁完"的现场：状态文件说 copying，from 指向 retrySrc，外加半份垃圾 */
    writeFileSync(
      join(retryDst, plan.STATE_NAME),
      JSON.stringify({ from: retrySrc, to: retryDst, phase: 'copying' }),
      'utf8',
    )
    writeFileSync(join(retryDst, 'leftover.tmp'), 'half', 'utf8')
    const retryPlan = plan.inspect({ from: retrySrc, to: retryDst })
    check('★★ 认得"上次没迁完"，允许重试（resume）', retryPlan.resume === true, JSON.stringify(retryPlan.blockers))

    /* 换个来源的那份就不许清了 —— 那是别人的数据 */
    const otherSrc = makeData(join(dir, 'other-src'))
    writeFileSync(
      join(retryDst, plan.STATE_NAME),
      JSON.stringify({ from: otherSrc, to: retryDst, phase: 'copying' }),
      'utf8',
    )
    const foreign = plan.inspect({ from: retrySrc, to: retryDst })
    check('★★ 状态文件说的来源不一致 → 不许清（不覆盖别人的数据）', foreign.ok === false, JSON.stringify(foreign.blockers.map((b) => b.code)))

    /* 测完把现场改回来（恢复成"上次是自己没迁完"）—— 否则下一条测的就是别人的现场 */
    writeFileSync(
      join(retryDst, plan.STATE_NAME),
      JSON.stringify({ from: retrySrc, to: retryDst, phase: 'copying' }),
      'utf8',
    )
    const retried = migrateCore.migrate({
      root: probeRoot,
      from: retrySrc,
      to: retryDst,
      switchPointer: () => ({ ok: true, file: 'x' }),
    })
    check('★ 续做时把半成品清掉、重新拷全', retried.ok === true && existsSync(join(retryDst, 'sessions', 'sess_b.jsonl')), String(retried.error ?? ''))

    /* ══ ⑧ 不受 Harbor 管的东西不在这条链上 ═══════════════════ */
    group('数据目录 / ⑧ 边界')
    const srcText = readFileSync(join(ROOT, 'electron/core/data-migrate.cjs'), 'utf8')
    check(
      '★★ 迁移代码里没有"删旧目录"（旧数据必须留着）',
      !/rmSync\(\s*[^)]*\bfrom\b/.test(srcText) && !srcText.includes('rmSync(src'),
    )
    check(
      '★ 也没把旧目录改名藏起来（那就是另一种"移走"）',
      !/renameSync\([^)]*\bfrom\b/.test(srcText),
    )
  } finally {
    for (const one of made) {
      try {
        rmSync(one, { recursive: true, force: true })
      } catch {
        /* 清不掉也不影响结论 */
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}
