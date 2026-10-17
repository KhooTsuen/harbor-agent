/**
 * **项目自定义测试的执行段**（2026-10-17 · 3A）
 *
 * ── 它做什么 ──────────────────────────────────────────────────
 *
 * 「用户为自己的项目写了一条测试命令 → Harbor 在**那个项目根**里跑它 →
 * 把结果按六种状态如实报回来」。命令只能来自用户亲笔配置，模型给不出命令，
 * 只给得出**条目 id**。
 *
 * ── ★ 六道闸（顺序不可换）────────────────────────────────────
 *
 *   ① **总开关**：`projectTests.enabled !== true` → `PROJECT_TEST_DISABLED`。
 *      每次调用**现读配置**，所以设置里关掉之后新请求立刻被拒（用户 A7）。
 *   ② **条目存在**：按 id 取，取不到 → `ITEM_NOT_FOUND`（不做模糊匹配）。
 *   ③ **项目根边界**：`policy.resolveWriteRoot(root, isoDir)` —— 必须落在
 *      允许的数据根之内，且 realpath 之后仍然如此（挡 `..` / 符号链接 / 目录联接）。
 *      ★ 判据**只有一处**（policy），这里不另写一套。
 *   ④ **命令来自配置**（不是模型给的）；形状在 `normalizeProjectTests` 已筛过，
 *      这里再断言一次（纵深防御：配置可能是手工改的）。
 *   ⑤ **cwd 固定 = 那个项目根**，不接受外部指定。
 *   ⑥ **执行走 `tools.execute('run_shell')`** —— 权限档、风险分级、审计落盘全在里面，
 *      逐次审批照常弹 PermissionBar。
 *
 * ── ★ 本轮补的三件事（B3/B4/B5）───────────────────────────────
 *
 *   · **并发上限** `MAX_CONCURRENT`：超了直接拒（`TOO_MANY_RUNNING`），不排队。
 *   · **执行期间撤权**：每 `RECHECK_MS` 复查一次开关与条目。撤掉就
 *     `abort()` → `run_shell` 走 `killTree` 杀**进程树**，终态强制记 CANCELLED，
 *     **哪怕进程恰好在同一瞬间跑完了，也不许报 PASS**（B4：不产生虚假成功）。
 *   · **终止确认**：`run_shell` 通过可选的 `ctx.onChild` 把子进程交出来，
 *     这里记下 pid；被中断 / 撤权之后**真的去查这个 pid 还在不在**，
 *     把结论写进正文与 meta。只置一个状态标记不算证明（用户明确要求）。
 *
 * ── ★ 诚实说明：这里**没有**进程沙箱 ─────────────────────────
 *
 *   `npm test` 内部能干什么，事前看不出来。所以「安全」的依据是：
 *   用户亲笔授权这条命令 + 逐次审批 + 审计 + cwd 钉死在他的项目里。
 *   **不是**「我们证明了它只读」。Harbor 目前也没有 OS 级文件/网络隔离
 *   （没有 AppContainer / Job Object / 防火墙规则）—— 这句话不能省。
 *
 * ⚠️ 不 require electron。
 */

const tests = require('./project-tests.cjs')
const { onAbort } = require('./abort.cjs')

/** 同时最多跑几条项目测试（并发上限） */
const MAX_CONCURRENT = 2
/** 执行中复查开关的间隔（撤权要在亚秒级被发现，不能等它跑完） */
const RECHECK_MS = 500
/** 终止后确认进程消失的最长等待（taskkill 是异步的，给它一点时间） */
const GONE_WAIT_MS = 3000

/** 当前正在跑几条（模块级计数；进程重启即归零） */
let running = 0

/* pid 探活与「整棵树确认终止」都在 proc-tree.cjs（那边能枚举后代，见它的文件头） */
const { pidAlive, confirmTreeGone } = require('./proc-tree.cjs')

/**
 * 跑一条项目测试。
 *
 * @param {{ toolsIndex: object, isoDir: string, args: object, ctx: object,
 *           startedAt: number }} input
 * @returns {Promise<{ ok: true, payload: object } | { ok: false, error: { code: string, message: string } }>}
 */
async function runProjectTest(input) {
  const { toolsIndex, isoDir, args, ctx, startedAt } = input
  const policy = require('./codex-mcp-policy.cjs')

  /* ① 总开关（现读：关掉之后新请求立刻被拒） */
  const cfg = tests.load()
  if (cfg.enabled !== true) {
    return {
      ok: false,
      error: {
        code: 'PROJECT_TEST_DISABLED',
        message: '项目测试未启用（设置 → 项目测试里打开，并至少配一条）',
      },
    }
  }

  /* ② 按 id 取条目 */
  const picked = tests.resolveItem(cfg.items, args?.id)
  if (picked.ok === false) return { ok: false, error: { code: picked.code, message: picked.message } }
  const item = picked.item

  /* ③ 项目根边界（唯一判据在 policy） */
  const root = policy.resolveWriteRoot(item.root, isoDir)
  if (root.ok === false) return { ok: false, error: { code: root.code, message: root.message } }

  /* ④ 命令再筛一次（配置可能是手工改的） */
  const shape = tests.validateItem({ root: item.root, command: item.command })
  if (shape.ok === false) return { ok: false, error: { code: shape.code, message: shape.message } }

  /* ⑦ 并发上限：超了直接拒，不排队（排队会让「用户以为跑完了」更难判） */
  if (running >= MAX_CONCURRENT) {
    return {
      ok: false,
      error: {
        code: 'TOO_MANY_RUNNING',
        message: `同时最多跑 ${MAX_CONCURRENT} 条项目测试（当前已有 ${running} 条在跑）—— 等它们结束再试`,
      },
    }
  }

  /* ⑧ 撤权检测：自建 controller，与外部 signal 合并（外部中断同样要能杀） */
  const ctrl = new AbortController()
  const offOuter = onAbort(ctx.signal, () => ctrl.abort())
  let childPid = 0
  /** 非空 = 执行期间权限被撤销（原因原文） */
  let revoked = ''
  /** 审批结果：true=批准 · false=拒绝 · null=这次没问（完全访问档）—— F5 要展示它 */
  let approved = null

  /** 此刻还允许跑这一条吗（现读配置；空串 = 允许） */
  const stillAllowed = () => {
    const now = tests.load()
    if (now.enabled !== true) return '设置里把项目测试关掉了'
    if (!now.items.some((x) => x.id === item.id)) return `条目 ${item.id} 被删掉或改得不合法了`
    return ''
  }

  const runCtx = {
    ...ctx,
    signal: ctrl.signal,
    /** run_shell 把子进程交出来 → 记 pid（终止后要靠它确认进程真的没了） */
    onChild: (child) => {
      childPid = Number(child?.pid) || 0
      try {
        ctx.onChild?.(child)
      } catch {
        /* 上一个调用方的钩子坏了不该影响这里 */
      }
    },
    /** 审批通过**之后**再核一次权限：审批期间被关掉 → 按拒绝结算 */
    confirm: async (request) => {
      const ok = (await ctx.confirm(request)) === true
      approved = ok
      if (!ok) return false
      const why = stillAllowed()
      if (why) {
        revoked = why
        return false
      }
      return true
    },
  }

  /* 执行中每 RECHECK_MS 复查一次：撤掉就立刻终止进程树（不是等它跑完再说） */
  const watch = setInterval(() => {
    if (revoked) return
    const why = stillAllowed()
    if (!why) return
    revoked = why
    try {
      ctrl.abort()
    } catch {
      /* 已经断了 */
    }
  }, RECHECK_MS)

  running += 1
  let out = ''
  try {
    out = await toolsIndex.execute(
      /* `projectTestId` 只为**审计可读**：`run_shell` 只读 command/cwd/timeout，
         多这一个字段不改变执行；但它能让审计一眼看出「这条命令属于哪条项目测试」
         （否则审计里只有一条 run_shell，事后分不出是谁跑的）。 */
      'run_shell',
      { command: item.command, cwd: root.abs, timeout: item.timeoutSec, projectTestId: item.id },
      runCtx,
    )
  } finally {
    clearInterval(watch)
    offOuter()
    running -= 1
  }

  const verdict = tests.classifyRun(out)

  /* ⑨ 终止确认（中断 / 超时 / 撤权三种都要查；正常跑完不必查）
   *
   * ★ 这里是本轮补的关键一段：原来是「父 pid 消失就算终止」，但真正干活的是
   *   cmd.exe 的儿子（node --test），测试脚本还能再起孙子。现在改成**枚举整棵树
   *   再逐个确认**（proc-tree.cjs），确认不了的原样写进结果，绝不假装杀干净了。 */
  const terminated =
    verdict.status === tests.STATUS.CANCELLED ||
    verdict.status === tests.STATUS.TIMEOUT ||
    Boolean(revoked)
  const treeInfo = terminated ? await confirmTreeGone(childPid, { timeoutMs: GONE_WAIT_MS }) : null
  const pidGone = treeInfo ? treeInfo.gone : null

  /* ⑩ 终态：撤权一律覆盖成 CANCELLED —— **哪怕恰好跑完了也不许报 PASS** */
  let status = verdict.status
  let reason = verdict.reason
  if (revoked) {
    status = tests.STATUS.CANCELLED
    reason = `执行期间权限被撤销（${revoked}）—— 已按终止处理，这次不算通过`
    if (pidGone === false) reason += `；⚠️ 仍有 ${treeInfo.remaining.length} 个进程在 ${GONE_WAIT_MS}ms 内未确认退出`
  }

  const passed = status === tests.STATUS.PASS
  const summary = passed ? [] : tests.summarizeFailure(out)
  const head = passed
    ? `测试通过（${item.label}）`
    : `测试未通过：${status}${verdict.exitCode === null ? '' : `（退出码 ${verdict.exitCode}）`}`
  const approvalText =
    approved === true ? '用户批准' : approved === false ? '用户拒绝（或超时）' : '未询问（当前权限档免审批）'
  const lines = [
    head,
    `项目：${root.abs}`,
    `条目：${item.id}（${item.label}）`,
    `命令：${item.command}`,
    `实际状态：${status}`,
    `退出码：${verdict.exitCode === null ? '（无）' : verdict.exitCode}`,
    `耗时：${Date.now() - startedAt} ms`,
    `审批：${approvalText}`,
  ]
  if (reason) lines.push(`说明：${reason}`)
  if (treeInfo) {
    const kids = treeInfo.tree.length
    lines.push(
      treeInfo.gone
        ? `终止确认：父进程 ${treeInfo.rootPid || '（未拿到 pid）'} + ${kids} 个受控子进程**已全部不存在**`
        : `终止确认：⚠️ 仍有 ${treeInfo.remaining.length} 个进程存活（${treeInfo.remaining.join(', ')}）—— 未确认终止`,
    )
    if (treeInfo.truncated) lines.push('终止确认：⚠️ 进程树超过枚举上限，**子进程没查全**（上述结论只覆盖查到的那些）')
  }
  if (summary.length > 0) lines.push('', '失败摘要：', ...summary.map((line) => `  ${line}`))
  lines.push('', '—— 完整输出 ——', String(out))

  return {
    ok: true,
    payload: {
      text: lines.join('\n'),
      toolOk: passed,
      meta: {
        harborTool: 'run_shell',
        testId: item.id,
        label: item.label,
        projectRoot: root.abs,
        command: item.command,
        status,
        exitCode: verdict.exitCode,
        failed: !passed,
        revoked: revoked || '',
        /* F5：审批结果也要能读到（界面/活动记录按它显示「是否经过审批」） */
        approved,
        pid: childPid,
        pidGone,
        /* F1~F3：受控子进程逐个确认的结果（查不到就如实空着） */
        treeSize: treeInfo ? treeInfo.tree.length : null,
        remaining: treeInfo ? treeInfo.remaining : null,
        treeTruncated: treeInfo ? treeInfo.truncated : null,
        ms: Date.now() - startedAt,
      },
    },
  }
}

module.exports = { runProjectTest, MAX_CONCURRENT, RECHECK_MS, GONE_WAIT_MS, pidAlive }
