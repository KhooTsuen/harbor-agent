/**
 * 把数据目录迁到用户指定的地方（可中断、可恢复、**绝不先删旧数据**）
 *
 * 检查与校验在 `data-migrate-plan.cjs`（那边只读，判据与理由都在它的文件头）；
 * 这里只管**按顺序执行**：标记 → 复制 → 校验 → 切指针。
 *
 * ── 顺序不能改 ────────────────────────────────────────────────
 *
 *   ① 检查 —— 调 `plan.inspect()`，任一阻碍就整体拒绝（一个字节都不动）
 *   ② 标记 —— 目标里先写 `.harbor-migrate.json`（中断后靠它认出来）
 *   ③ 复制 —— `fs.cpSync` **同步**跑
 *   ④ 校验 —— 调 `plan.verify()`，**不看复制命令的退出码**
 *   ⑤ 切指针 —— 一次原子 rename，这是唯一"生效"的动作
 *   ⑥ 旧目录**原样保留** —— 绝不自动删，也不清理
 *
 * ── 为什么同步复制 ────────────────────────────────────────────
 *
 * 迁移期间数据不能被改，否则拷出来是个不一致的快照。用同步 `fs` 会占住主进程，
 * 别的写入（日志追加、会话落盘、任务台账）全部排队 —— 这就是"运行状态协调"的
 * 落地方式，不需要另造一套锁。代价是几 GB 数据会卡几秒到几十秒，前端转圈。
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
const path = require('node:path')
const plan = require('./data-migrate-plan.cjs')

const { STATE_NAME, readState } = plan

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
function migrate(input) {
  const started = Date.now()
  const checked = plan.inspect({ from: input?.from, to: input?.to })
  if (!checked.ok) {
    return fail('check', checked.blockers[0]?.text ?? '检查没通过', { blockers: checked.blockers })
  }

  const src = checked.from
  const dst = checked.to

  /* ② 先写状态：中断后靠它认出"这是个没迁完的目标" */
  try {
    fs.mkdirSync(dst, { recursive: true })
    fs.writeFileSync(
      path.join(dst, STATE_NAME),
      JSON.stringify({ from: src, to: dst, phase: 'copying', at: Date.now() }, null, 2),
      'utf8',
    )
  } catch (error) {
    return fail('mark', `目标目录不可写：${error instanceof Error ? error.message : error}`)
  }

  /* ③ 复制（同步：期间主进程被占住，没有别的写入能插进来） */
  try {
    if (checked.resume) {
      /* 上次的半成品：只清目标里除状态文件之外的东西 —— 那是我自己刚拷的 */
      for (const name of fs.readdirSync(dst)) {
        if (name !== STATE_NAME) fs.rmSync(path.join(dst, name), { recursive: true, force: true })
      }
    }
    fs.cpSync(src, dst, { recursive: true, force: true, dereference: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    markPhase(dst, 'copy_failed', message)
    return fail('copy', `复制失败：${message}（旧数据一个字节没动）`, { from: src, to: dst })
  }

  /* ④ 校验 —— 不看复制命令的退出码，自己数 */
  markPhase(dst, 'verifying', '')
  const verified = plan.verify(src, dst)
  if (!verified.ok) {
    markPhase(dst, 'verify_failed', verified.error)
    return fail('verify', `${verified.error}（旧数据一个字节没动，指针没切）`, {
      from: src,
      to: dst,
      detail: verified,
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
  }
}

module.exports = { STATE_NAME, migrate, inspect: plan.inspect, verify: plan.verify }
