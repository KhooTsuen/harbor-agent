/**
 * **项目自定义测试**（2026-10-17 · 3A）—— 配置形状 + 校验 + 结果状态分类
 *
 * ── 它解决的问题 ───────────────────────────────────────────────
 *
 * 原来的 `harbor_run_test` 只会跑**一个写死的常量命令**（`node --test`），
 * 用户没法为「自己那个项目」指定测试命令。这里补的是**配置化**：
 * 每个项目一条（项目根 + 命令 + 超时），由用户自己在设置里写下来。
 *
 * ── ★ 六道不变量（用户第 3 节）────────────────────────────────
 *
 *   ① **默认关闭**：`enabled` 不为 true → 一律拒绝（`PROJECT_TEST_DISABLED`）。
 *   ② **命令只能来自配置**：模型能给的只有 **item id**，给不出命令 ——
 *      命令行天然来自用户亲笔，不存在「模型临时拼一条」这条路。
 *   ③ **命令不许带串联/重定向字符**（`& | < > ^ %` 引号 换行）——
 *      有它们就不是「跑一条测试」，而是「跑一段脚本」。
 *   ④ **项目根由主进程校验**：本模块只看形状；是否落在允许的数据根内
 *      由 `policy.resolveWriteRoot` 判（唯一一处，不在这里再写一套）。
 *   ⑤ **有上限**：条数 / 命令长度 / 超时秒数都有天花板，避免配置把进程撑爆。
 *   ⑥ **状态如实分类**：PASS / FAIL / TIMEOUT / CANCELLED / DENIED / ERROR
 *      六种分开（用户 A5）—— 绝不把「退出码非 0」说成成功。
 *
 * ── ★ 关于「npm 脚本可能执行任意代码」的诚实说明 ──────────────
 *
 *   Harbor **没有**进程级沙箱（没有 OS 级的文件系统 / 网络隔离）。一条
 *   `npm test` 内部能干什么，事前无法从命令行看出来。所以这里的边界是：
 *   **用户亲笔授权 + 逐次审批 + 审计 + cwd 固定在他指定的目录**，
 *   不是「我们证明了它只读」。这句话必须一直摆在明面上 —— 不能因为
 *   命令叫 test 就宣称它安全。
 *
 * ⚠️ 不 require electron（纯函数 + 一次 config 读取，自检可直接跑）。
 */

const { STATUS, classifyRun, summarizeFailure } = require('./project-test-status.cjs')

/** 默认值：**全关**（装了 Harbor 不会因为升级就多出一条能跑别人脚本的通道） */
const PROJECT_TESTS_DEFAULTS = {
  enabled: false,
  items: [],
}

/** 允许的键（多一个都会被丢掉 —— 手工改配置也塞不进别的） */
const PROJECT_TESTS_KEYS = Object.keys(PROJECT_TESTS_DEFAULTS)

/** 上限（畸形配置别把执行器撑爆） */
const LIMITS = {
  items: 8,
  command: 300,
  root: 500,
  label: 60,
  timeoutSec: 600,
  defaultTimeoutSec: 300,
}

/**
 * 命令里一旦出现这些字符，就不只是「跑一条测试」了：
 *   `&` `|` `&&` `||` 串联 · `<` `>` 重定向 · `^` cmd 转义 · `%` 变量展开 ·
 *   引号（会改变参数边界）· 换行（第二条命令）
 */
const UNSAFE_COMMAND = /[&|<>^%`"'\r\n]/

/** 取字符串并去空格 */
function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 数值夹到区间里 */
function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 一条项目测试的形状校验（**只看形状**；项目根是否允许在 policy 那边判）。
 *
 * @param {{ root?: unknown, command?: unknown }} item
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function validateItem(item) {
  const root = str(item?.root)
  const command = str(item?.command)
  if (!root) return { ok: false, code: 'ROOT_MISSING', message: '项目根不能为空' }
  if (!command) return { ok: false, code: 'COMMAND_MISSING', message: '测试命令不能为空' }
  if (root.length > LIMITS.root) {
    return { ok: false, code: 'ROOT_TOO_LONG', message: `项目根过长（上限 ${LIMITS.root} 字符）` }
  }
  if (command.length > LIMITS.command) {
    return { ok: false, code: 'COMMAND_TOO_LONG', message: `命令过长（上限 ${LIMITS.command} 字符）` }
  }
  if (UNSAFE_COMMAND.test(command)) {
    return {
      ok: false,
      code: 'COMMAND_UNSAFE',
      message: '命令里不能有串联 / 重定向 / 变量展开字符（& | < > ^ % 引号 换行）—— 只允许一条简单命令',
    }
  }
  return { ok: true }
}

/**
 * 把外部给的 `projectTests` 收成合法形状。
 *
 * 非法条目**整条丢掉**（不猜用户想干嘛）；`enabled` 只认严格 true。
 *
 * @param {unknown} src 磁盘 / 界面传来的原始值
 * @returns {{ enabled: boolean, items: Array<{ id: string, label: string, root: string, command: string, timeoutSec: number }> }}
 */
function normalizeProjectTests(src) {
  const a = src && typeof src === 'object' && !Array.isArray(src) ? /** @type {any} */ (src) : {}
  const enabled = a.enabled === true
  const raw = Array.isArray(a.items) ? a.items : []
  const items = []
  for (const one of raw.slice(0, LIMITS.items)) {
    if (!one || typeof one !== 'object') continue
    const item = /** @type {any} */ (one)
    const root = str(item.root)
    const command = str(item.command)
    /* 形状不合法的整条丢掉 —— 保留一条跑不了的空条目只会让界面更难读 */
    if (validateItem({ root, command }).ok !== true) continue
    const id = str(item.id).slice(0, 40) || `pt${items.length + 1}`
    /* id 去重：后出现的丢掉（同 id 两条会让「按 id 取」变得不可预测） */
    if (items.some((x) => x.id === id)) continue
    items.push({
      id,
      label: str(item.label).slice(0, LIMITS.label) || id,
      root,
      command,
      timeoutSec: clamp(item.timeoutSec, 5, LIMITS.timeoutSec, LIMITS.defaultTimeoutSec),
    })
  }
  return { enabled, items }
}

/**
 * 按 id 取一条（**大小写敏感**，不做模糊匹配）。
 *
 * @param {Array<{ id: string }>} items
 * @param {unknown} id
 * @returns {{ ok: true, item: object } | { ok: false, code: string, message: string }}
 */
function resolveItem(items, id) {
  const key = str(id)
  if (!key) return { ok: false, code: 'ITEM_MISSING', message: '没有指定要跑哪一条项目测试（需要 id）' }
  const list = Array.isArray(items) ? items : []
  const hit = list.find((x) => x && x.id === key)
  if (!hit) {
    const known = list.map((x) => x.id).join(' / ') || '（一条都没配）'
    return { ok: false, code: 'ITEM_NOT_FOUND', message: `没有这一条项目测试：${key}（已配置：${known}）` }
  }
  return { ok: true, item: hit }
}

/**
 * 读当前配置里的 `projectTests`（读不到 → 全关）。
 *
 * 每次调用现读（不缓存）：设置里关掉之后，**新请求立刻被拒**（用户 A7）。
 *
 * @returns {{ enabled: boolean, items: Array<{ id: string, label: string, root: string, command: string, timeoutSec: number }> }}
 */
function load() {
  try {
    const cfg = require('./config.cjs').get()
    const raw = cfg && cfg.projectTests
    if (raw && typeof raw === 'object') return normalizeProjectTests(raw)
  } catch {
    /* 落到全关 */
  }
  return { enabled: false, items: [] }
}

module.exports = {
  PROJECT_TESTS_DEFAULTS,
  PROJECT_TESTS_KEYS,
  LIMITS,
  UNSAFE_COMMAND,
  STATUS,
  validateItem,
  normalizeProjectTests,
  resolveItem,
  classifyRun,
  summarizeFailure,
  load,
}
