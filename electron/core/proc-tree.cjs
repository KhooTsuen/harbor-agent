/**
 * **进程树的枚举与「终止后确认」**（2026-10-17 · 3A 收尾）
 *
 * ── 为什么需要它（用户 F1~F3）────────────────────────────────
 *
 * 上一轮只做了「父 pid 消失了」这一件事，然后就写了「已终止」。这不够：
 *
 *   · `run_shell` 起的是 `cmd.exe`，真正干活的是它的**儿子**（`node --test`），
 *     测试脚本还能再起孙子（`npm` → `node` → 子进程）。
 *   · `taskkill /T` 一般能连子树一起杀，但它**是异步的、也不回报结果**。
 *     `abort.cjs` 的注释写得很清楚：故意用 spawn 不等结果，因为调用方要的是
 *     「立刻结算」。于是「结算了」被当成「杀干净了」—— 这是本轮要补的那一段。
 *   · Windows 上父亲死后，孤儿的 `ParentProcessId` **仍指向原来那个（已死的）pid**，
 *     所以「按父 pid 递归查」在杀掉之后依然查得到残留 —— 这个特性正好能用来取证。
 *
 * ── ★ 两条铁律 ────────────────────────────────────────────────
 *
 *   ① **先快照、再杀、再逐个确认**：快照拿不到的东西事后也查不出来。
 *   ② **确认不了就说确认不了**：不拿「我调过 taskkill」冒充「进程没了」，
 *      返回值里 `remaining` 原样带出去，由调用方如实写进结果正文。
 *
 * ⚠️ 不 require electron。
 */

const { spawnSync } = require('node:child_process')

/** 递归深度上限（防畸形进程关系把这里拖成死循环） */
const MAX_DEPTH = 6
/** 一次最多认多少个后代（超了就如实说「查不全」，不假装数对了） */
const MAX_NODES = 400
/** wmic 单次查询超时（毫秒） */
const QUERY_TIMEOUT_MS = 8000

/** pid 还活着吗（`kill(pid, 0)` 只探活、不发信号；EPERM = 存在但无权限） */
function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** `wmic ... get ProcessId /value` 的输出 → pid 数组 */
function parsePids(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^ProcessId=(\d+)\s*$/)
    if (m) out.push(Number(m[1]))
  }
  return out
}

/**
 * 直接子进程 pid 列表。
 *
 * Windows 走 `wmic`（这台机器有：`C:\Windows\System32\wbem\WMIC.exe`，实测 264ms）。
 * wmic 在新版 Windows 上已被标记弃用，所以**失败时回退 PowerShell CIM** ——
 * 两条都不通就返回空数组，调用方会把「查不到」如实记成「无法确认」。
 *
 * @param {number} pid
 * @returns {number[]}
 */
function childrenOf(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n < 0) return []

  const viaWmic = spawnSync(
    'wmic',
    ['process', 'where', `ParentProcessId=${n}`, 'get', 'ProcessId', '/value'],
    { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS },
  )
  if (viaWmic.status === 0) return parsePids(viaWmic.stdout)

  const viaPs = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${n}" | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS },
  )
  if (viaPs.status === 0) {
    return String(viaPs.stdout ?? '')
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((x) => Number.isInteger(x) && x > 0)
  }
  return []
}

/**
 * 一个进程的**全部后代**（不含它自己，广度优先）。
 *
 * @param {number} pid
 * @returns {{ pids: number[], truncated: boolean }}
 *          `truncated: true` = 碰到深度/数量上限，**没查全**（调用方必须如实说明）
 */
function listDescendants(pid) {
  const root = Number(pid)
  if (!Number.isInteger(root) || root <= 0) return { pids: [], truncated: false }

  const seen = new Set([root])
  const pids = []
  let frontier = [root]
  let truncated = false

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next = []
    for (const parent of frontier) {
      for (const child of childrenOf(parent)) {
        if (seen.has(child)) continue
        seen.add(child)
        pids.push(child)
        next.push(child)
        if (pids.length >= MAX_NODES) {
          truncated = true
          break
        }
      }
      if (truncated) break
    }
    if (truncated) break
    frontier = next
  }
  /* 还有下一层没查 = 也没查全 */
  if (frontier.length > 0 && pids.length > 0) {
    const leafHasChild = frontier.some((p) => childrenOf(p).length > 0)
    if (leafHasChild) truncated = true
  }
  return { pids, truncated }
}

/** 等这一批 pid 全部消失；返回仍未消失的那些（空数组 = 全都确认没了） */
async function waitAllGone(pids, timeoutMs) {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0)
  if (list.length === 0) return []
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const step = 100
  for (;;) {
    const left = list.filter(pidAlive)
    if (left.length === 0) return []
    if (Date.now() >= deadline) return left
    await new Promise((r) => setTimeout(r, step))
  }
}

/** 对还活着的 pid 再补一次强杀（`taskkill /F`，不再管子树 —— 树已经按快照逐个点名） */
function killPids(pids) {
  for (const pid of pids) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: QUERY_TIMEOUT_MS,
      })
    } catch {
      /* 进程可能已经不在了 */
    }
  }
}

/**
 * **终止确认**：父进程 + 所有受控后代，逐个确认。
 *
 * 顺序（不可换）：
 *   ① 快照整棵树（父 + 后代 pid）
 *   ② 对快照里**还活着**的补一次强杀（原 `killTree` 是异步的，这里等结果）
 *   ③ 等它们全部消失（`timeoutMs`）
 *   ④ 仍未消失的原样返回 —— 由调用方如实写进结果
 *
 * @param {number} rootPid
 * @param {{ timeoutMs?: number, snapshot?: number[] }} [opts]
 *        `snapshot` = 调用方在终止**之前**自己拍的树（更准；给了就不再重查一次）
 * @returns {Promise<{ rootPid: number, tree: number[], gone: boolean,
 *                     remaining: number[], truncated: boolean }>}
 */
async function confirmTreeGone(rootPid, opts = {}) {
  const root = Number(rootPid)
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000

  let tree = Array.isArray(opts.snapshot) ? opts.snapshot.filter((p) => Number.isInteger(p) && p > 0) : []
  let truncated = false
  if (tree.length === 0) {
    const found = listDescendants(root)
    tree = found.pids
    truncated = found.truncated
  }

  /* 父进程也算进来：它同样要确认 */
  const all = Number.isInteger(root) && root > 0 ? [root, ...tree] : [...tree]
  const alive = all.filter(pidAlive)
  if (alive.length > 0) killPids(alive)

  const remaining = await waitAllGone(all, timeoutMs)
  return { rootPid: root, tree, gone: remaining.length === 0, remaining, truncated }
}

module.exports = {
  MAX_DEPTH,
  MAX_NODES,
  pidAlive,
  childrenOf,
  listDescendants,
  waitAllGone,
  confirmTreeGone,
}
