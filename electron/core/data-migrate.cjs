/**
 * 把数据目录迁到用户指定的地方（可中断、可恢复、**绝不先删旧数据**）
 *
 * 检查与校验在 `data-migrate-plan.cjs`（那边只读，判据与理由都在它的文件头）；
 * 这里只管**按顺序执行**：标记 → 复制 → 校验 → 切指针。
 *
 * ── 为什么**异步**复制（2026-11-07 修正，V1 的判断是错的）────────
 *
 * V1 用 `fs.cpSync` 同步复制，理由写的是「主进程被占住 → 没有别的写入能插进来
 * → 这就是"运行状态协调"」。**这个理由不成立**，两个方向都错：
 *
 *   ① **它保护不了一致性**：`data/chromium` 是 **Chromium 自己的进程**在写，
 *      主进程把自己阻塞住根本拦不住它；渲染层也照画，IPC 只是排队等着。
 *      换句话说「我卡住了自己」≠「别人不会写」。
 *   ② **代价是真的**：4.8GB 同步复制 = main 进程几十秒不响应 —— 界面像死了一样。
 *
 * 现在的一致性靠**证据**，不靠「我卡住了谁」：
 *   a. 纯缓存目录不复制（可重建 + 正在被写，搬过去必然是半旧的）
 *   b. 复制完对**每一个文件**算 SHA-256 与源比（`data-migrate-verify.cjs`）
 *   c. 复制前后各拍一次源快照，差异如实报出来（诊断用，不当成功）
 *   d. 校验不过 → **只重拷那几个文件**再验一次（最多 2 轮，日志追加这类抖动
 *      靠它收敛）；还不过 → 不切指针，旧数据一个字节没动
 *
 * ── 顺序不能改 ────────────────────────────────────────────────
 *
 *   ① 检查 —— 调 `plan.inspect()`，任一阻碍就整体拒绝（一个字节都不动）
 *   ② 标记 —— 目标里先写 `.harbor-migrate.json`（中断后靠它认出来）
 *   ③ 拍快照 → 复制（异步，每 64 个文件让出事件循环）
 *   ④ 校验 —— **全量 SHA-256**，不看复制命令的退出码
 *   ⑤ 切指针 —— 一次原子 rename，这是唯一"生效"的动作
 *   ⑥ 旧目录**原样保留** —— 绝不自动删，也不清理
 *
 * ── 中断了怎么办（三个位置都能恢复）──────────────────────────
 *
 *   切指针**之前**断 → 指针还指着源 → 应用照旧跑，跟没迁一样；源一个字节没动。
 *   切指针**之后**断 → 目标已经校验过 → 正常用；旧目录还在，随时能搬回去。
 *   复制**中途**断   → 目标里躺着半份 + 状态文件；下次重试时 `inspect()` 据此
 *                     认出"这是没完成的迁移目标"，允许清空重来（删的是我自己
 *                     刚拷的，不是用户数据 —— 判据里要求状态文件记的 from 一致）。
 *
 * ── 明确不做的事 ──────────────────────────────────────────────
 *
 *   · 不删除、不清理、不移动旧目录（用户确认无误后自己删）。
 *   · 不迁移不受 Harbor 管的东西（Chromium 缓存就在 data 下，会一起搬走；
 *     但 Provider / CLI 自己存在别处的缓存不在本模块范围内）。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const plan = require('./data-migrate-plan.cjs')
/* 搬字节（异步 + 拍快照）与核对字节（全量 SHA-256）各住一个文件 */
const copy = require('./data-migrate-copy.cjs')
const verify = require('./data-migrate-verify.cjs')

const { STATE_NAME, readState } = plan

/** 校验不过时重拷坏文件的最多轮数（日志追加这类抖动靠它收敛；不是无限重试） */
const REPAIR_ROUNDS = 2

const fail = (phase, error, extra = {}) => ({ ok: false, phase, error, ...extra })

/** 更新状态文件的阶段（写失败不影响主流程，它只是给人看的线索） */
function markPhase(to, phase, error) {
  try {
    const state = readState(to) ?? {}
    fs.writeFileSync(
      path.join(to, STATE_NAME),
      JSON.stringify({ ...state, phase, error: error || '', at: Date.now() }, null, 2),
      'utf8',
    )
  } catch {
    /* 记不上就算了 */
  }
}

/**
 * 执行迁移。
 *
 * @param {{ root: string, from: string, to: string, switchPointer?: (to: string) => object }} input
 *   `root` = 程序根目录（决定指针文件写哪）；`switchPointer` 只给测试注入，
 *   生产不传 → 用 `data-location.write`。
 * @returns {{ ok: boolean, phase?: string, error?: string, from?: string, to?: string,
 *             files?: number, bytes?: number, ms?: number, pointer?: string, keptOldDir?: string }}
 */
/** 这次校验失败里，哪几个文件值得重拷一遍（缺的 / 大小不符的 / hash 对不上的） */
function repairList(result) {
  if (!result || result.ok) return []
  const out = []
  if (Array.isArray(result.missing)) out.push(...result.missing)
  if (Array.isArray(result.sized)) out.push(...result.sized)
  if (Array.isArray(result.bad)) out.push(...result.bad.map((item) => item.rel))
  return [...new Set(out)].slice(0, 500)
}

/**
 * 执行迁移（**异步**：复制与校验都分批让出事件循环，界面不会卡死）。
 *
 * @param {{ root: string, from: string, to: string,
 *           switchPointer?: (to: string) => object,
 *           onProgress?: (done: number, total?: number) => void }} input
 *   `root` = 程序根目录（决定指针文件写哪）；`switchPointer` / `onProgress` 只给
 *   测试与界面用，生产不传 `switchPointer` → 用 `data-location.write`。
 * @returns {Promise<{ ok: boolean, phase?: string, error?: string, from?: string, to?: string,
 *             files?: number, bytes?: number, ms?: number, pointer?: string,
 *             keptOldDir?: string, concurrentChanges?: Array<{rel: string, reason: string}>,
 *             repaired?: number }>}
 */
async function migrate(input) {
  const started = Date.now()
  const checked = plan.inspect({ from: input?.from, to: input?.to })
  if (!checked.ok) {
    return fail('check', checked.blockers[0]?.text ?? '检查没通过', { blockers: checked.blockers })
  }

  const src = checked.from
  const dst = checked.to
  const progress = typeof input?.onProgress === 'function' ? input.onProgress : null

  /* ② 先写状态：中断后靠它认出"这是个没迁完的目标" */
  try {
    await fsp.mkdir(dst, { recursive: true })
    await fsp.writeFile(
      path.join(dst, STATE_NAME),
      JSON.stringify({ from: src, to: dst, phase: 'copying', at: Date.now() }, null, 2),
      'utf8',
    )
  } catch (error) {
    return fail('mark', `目标目录不可写：${error instanceof Error ? error.message : error}`)
  }

  /* ③ 清半成品（只清我自己上次拷的）→ 拍快照 → 异步复制 */
  let before = []
  try {
    if (checked.resume) {
      for (const name of await fsp.readdir(dst)) {
        if (name !== STATE_NAME) await fsp.rm(path.join(dst, name), { recursive: true, force: true })
      }
    }
    before = await copy.snapshot(src)
    await copy.copyTree({ from: src, to: dst, onProgress: progress })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    markPhase(dst, 'copy_failed', message)
    return fail('copy', `复制失败：${message}（旧数据一个字节没动）`, { from: src, to: dst })
  }

  /* 复制期间源动过没有（诊断信息；真正的一致性判据是下面的全量 SHA-256） */
  let after = []
  try {
    after = await copy.snapshot(src)
  } catch {
    /* 拍不到就当没变化 —— 内容对不对由 verifyAll 说了算 */
  }
  const moved = copy.diffSnapshots(before, after)

  /* ④ 全量校验 —— 不看复制命令的退出码，逐文件比 SHA-256 */
  markPhase(dst, 'verifying', '')
  let verified = await verify.verifyAll({ from: src, to: dst, source: before })

  /*
   * 校验不过 → **只重拷那几份坏文件**再验一次（最多 REPAIR_ROUNDS 轮）。
   * 为什么需要它：迁移期间日志还在追加，刚拷完那一瞬两边就可能不等。
   * 无限重试不行（会永远追不上正在写的东西），一刀切失败也不行（正常迁移会被
   * 一点抖动打死）。两轮之后还不过，就是真的有问题，如实报红。
   */
  let repaired = 0
  for (let round = 0; round < REPAIR_ROUNDS && !verified.ok; round += 1) {
    const names = repairList(verified)
    if (names.length === 0) break
    repaired += names.length
    for (const rel of names) {
      try {
        await fsp.mkdir(path.dirname(path.join(dst, rel)), { recursive: true })
        await fsp.copyFile(path.join(src, rel), path.join(dst, rel))
      } catch {
        /* 拷不动就让下一轮校验如实报红 */
      }
    }
    verified = await verify.verifyAll({ from: src, to: dst, source: before })
  }

  if (!verified.ok) {
    markPhase(dst, 'verify_failed', verified.error)
    return fail('verify', `${verified.error}（旧数据一个字节没动，指针没切）`, {
      from: src,
      to: dst,
      detail: verified,
      /* 在这期间动过的文件 —— 用户拿它判断是不是自己还开着什么在写 */
      concurrentChanges: moved.slice(0, 20),
    })
  }

  /* ⑤ 切指针 —— 唯一"生效"的动作，一次原子 rename */
  const writer =
    typeof input?.switchPointer === 'function'
      ? input.switchPointer
      : (target) => require('./data-location.cjs').write(String(input?.root ?? ''), target)
  const switched = writer(dst)
  if (!switched?.ok) {
    markPhase(dst, 'switch_failed', switched?.error ?? '写指针失败')
    return fail('switch', `数据拷好了但指针没切成功：${switched?.error ?? ''}（旧数据没动，重启还是用旧的）`, {
      from: src,
      to: dst,
    })
  }

  markPhase(dst, 'done', '')
  return {
    ok: true,
    from: src,
    to: dst,
    files: verified.files,
    bytes: checked.bytes,
    ms: Date.now() - started,
    pointer: switched.file ?? '',
    /** 旧目录**没删**，也没清 —— 用户确认无误后自己处理 */
    keptOldDir: src,
    /** 迁移期间源里被改过、但最终校验一致的文件（空 = 全程没动过） */
    concurrentChanges: moved.slice(0, 20),
    /** 校验不过时重拷过几个文件（0 = 一次就过） */
    repaired,
  }
}

module.exports = { STATE_NAME, migrate, inspect: plan.inspect, verify: verify.verifyAll }
