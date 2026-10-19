/**
 * IPC：项目自定义测试的**设置与校验**（2026-10-17 · 3A）
 *
 * ── 只做两件事 ────────────────────────────────────────────────
 *
 *   ① `projectTests:status` —— 把**当前配置 + 每条的真实校验结果**交给界面。
 *      ★ 界面不许自己判断「这个目录行不行」，否则就是「前端校验冒充安全边界」。
 *   ② `projectTests:set` —— 改配置。**项目根必须在这里验**（用户第 3 节 / A6）：
 *      判据是 `project-roots.cjs`（目录真实存在 + 不是盘符根/系统目录；
 *      realpath 之后仍然如此 —— 挡住 `..`、符号链接、目录联接）。
 *      ★ 3C-2：这里**不再要求根落在数据根之内** —— 用户自己的项目目录（E 盘等）
 *        本来就在 data 之外。授权机制改成「写进 items[].root 才算授权」，
 *        模型给不出新的根（见 `core/project-roots.cjs`）。
 *
 * ── ★ 命令的校验也在这里 ──────────────────────────────────────
 *
 * `project-tests.validateItem` 会拒掉带 `& | < > ^ %` 引号换行的命令。
 * 这是**配置层**的收紧：目标是「一条简单命令」，不是「一段脚本」。
 *
 * ⚠️ 配置里存的是**用户亲笔写的命令**。Harbor 没有进程级沙箱，
 *    `npm test` 内部能干什么事前看不出来 —— 所以这里能保证的是
 *    「用户明确授权 + 逐次审批 + 审计」，不是「它只读」。
 */

const config = require('../core/config.cjs')
const log = require('../core/log.cjs')
const tests = require('../core/project-tests.cjs')

/**
 * 校验一个项目根（主进程侧，唯一判据在 project-roots.cjs）。
 *
 * ★ 3C-2 改造：原来要求根必须落在 `DIRS.data` 之内 —— 于是**用户自己的项目目录**
 *   （`E:\独立游戏` 这类）在界面上根本存不进去。现在改成「用户显式授权的项目根」：
 *   保存时只验**目录真实存在 + 不是盘符根/系统目录**；
 *   「这个根能做什么动作」由 `status()` 的 `actions` 如实告诉界面。
 *
 * ★ 默认仍然不信任任何外部项目：不在 `items[].root` 里的路径**一次也用不了**
 *   （`resolveAuthorizedRoot` 会拒），模型也给不出新的根。
 *
 * @param {string} root
 * @returns {{ ok: boolean, real: string, message: string }}
 */
function checkRoot(root) {
  const roots = require('../core/project-roots.cjs')
  const text = String(root ?? '').trim()
  if (!text) return { ok: false, real: '', message: '项目根不能为空' }
  const real = roots.realRoot(text)
  if (!real) return { ok: false, real: '', message: `项目根不存在或不是目录：${text}` }
  if (roots.isForbidden(real)) {
    return { ok: false, real, message: `这个目录不能作为项目根（盘符根 / 系统目录）：${real}` }
  }
  return { ok: true, real, message: '' }
}

/**
 * 真实状态：配置 + 每条条目单独校验的结果（界面据此显示「这条能不能用」）。
 * @returns {object}
 */
function status() {
  const cfg = tests.load()
  return {
    enabled: cfg.enabled,
    items: cfg.items.map((item) => {
      const root = checkRoot(item.root)
      const shape = tests.validateItem({ root: item.root, command: item.command })
      const commandOk = shape.ok === true
      /* 这条根**现在**能做什么（读/跑测试/改/恢复）—— 唯一判据在 project-roots.cjs */
      const { DIRS } = require('../core/paths.cjs')
      const grant = require('../core/project-roots.cjs').describe(item, DIRS.data)
      return {
        ...item,
        rootValid: root.ok,
        rootReal: root.real,
        rootError: root.ok ? '' : root.message,
        commandValid: commandOk,
        commandError: commandOk ? '' : shape.message,
        /* 这条根上允许的动作（外部项目默认只有 read/test） */
        actions: grant.actions,
        /* 真正可用 = 根合法 + 命令合法 + 总开关开着 */
        usable: cfg.enabled && root.ok && commandOk,
      }
    }),
    /* 六种状态的含义（界面照它显示，不另编一套） */
    statuses: tests.STATUS,
    limits: tests.LIMITS,
  }
}

/**
 * 落盘前的整体校验：**任何一条不合法就整批拒绝**（不静默丢掉用户写的东西 ——
 * 那会让他以为保存成功了，回头发现少了条目）。
 *
 * @param {unknown} incoming 界面传来的 `{ enabled, items }`
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateAll(incoming) {
  const normalized = tests.normalizeProjectTests(incoming)
  const src = incoming && typeof incoming === 'object' ? /** @type {any} */ (incoming) : {}
  const rawItems = Array.isArray(src.items) ? src.items : []
  /* 界面上写了条目但被 normalize 丢掉 → 说明形状不合法，明确报错而不是静默丢 */
  if (rawItems.length !== normalized.items.length) {
    return { ok: false, message: '有条目没通过校验（项目根或命令为空 / 超长 / 含 & | < > ^ % 引号或换行）' }
  }
  for (const item of normalized.items) {
    const root = checkRoot(item.root)
    if (!root.ok) return { ok: false, message: `${item.id}：${root.message}` }
  }
  return { ok: true, value: normalized }
}

function register({ ipcMain }) {
  ipcMain.handle('projectTests:status', () => ({ ok: true, state: status() }))

  ipcMain.handle('projectTests:set', (_event, partial) => {
    const patch = partial && typeof partial === 'object' ? partial : {}
    /* 只接受 enabled / items 两个键（多塞的一律忽略） */
    const incoming = {
      enabled: patch.enabled === true,
      items: Array.isArray(patch.items) ? patch.items : [],
    }
    const checked = validateAll(incoming)
    if (checked.ok === false) {
      log.warn(`项目测试：拒绝保存（${checked.message}）`)
      return { ok: false, error: checked.message, state: status() }
    }
    config.patch({ projectTests: checked.value })
    log.info(`项目测试设置已更新：enabled=${checked.value.enabled} 条目=${checked.value.items.length}`)
    return { ok: true, state: status() }
  })
}

module.exports = { register, status, checkRoot, validateAll }
