/**
 * IPC：项目自定义测试的**设置与校验**（2026-10-17 · 3A）
 *
 * ── 只做两件事 ────────────────────────────────────────────────
 *
 *   ① `projectTests:status` —— 把**当前配置 + 每条的真实校验结果**交给界面。
 *      ★ 界面不许自己判断「这个目录行不行」，否则就是「前端校验冒充安全边界」。
 *   ② `projectTests:set` —— 改配置。**项目根必须在这里验**（用户第 3 节 / A6）：
 *      判据是 `policy.resolveWriteRoot`（必须落在允许的数据根内，
 *      且 realpath 之后仍然如此 —— 挡住 `..`、符号链接、目录联接）。
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
const policy = require('../core/codex-mcp-policy.cjs')
const tests = require('../core/project-tests.cjs')

/**
 * 校验一个项目根（主进程侧，唯一判据在 policy）。
 *
 * 允许的数据根 = `DIRS.data` 之下（开发版就是 `<repo>/data`）。
 * 用户通常会用 `<data>/unit-test-data/<项目>` 这一层。
 *
 * @param {string} root
 * @returns {{ ok: boolean, real: string, message: string }}
 */
function checkRoot(root) {
  const { DIRS } = require('../core/paths.cjs')
  const text = String(root ?? '').trim()
  if (!text) return { ok: false, real: '', message: '项目根不能为空' }
  const res = policy.resolveWriteRoot(text, DIRS.data)
  if (res.ok === false) return { ok: false, real: '', message: res.message }
  return { ok: true, real: res.abs, message: '' }
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
      return {
        ...item,
        rootValid: root.ok,
        rootReal: root.real,
        rootError: root.ok ? '' : root.message,
        commandValid: commandOk,
        commandError: commandOk ? '' : shape.message,
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
