/**
 * **授权项目根** —— 用户显式授权的外部项目目录（2026-10-17 · 3C-2）
 *
 * ── 它解决什么 ────────────────────────────────────────────────
 *
 * 3A 起 `resolveWriteRoot` 要求项目根**必须落在数据根之内**。这在 MCP 场景是对的
 * （外部进程不该写正式源码），但它把真实用法一刀切死了：`data/` 永远在源码根之下，
 * 所以「项目根 = 用户自己的项目目录」在结构上**必然被拒** —— 3C-1 真机第一次自举
 * 就撞在这里。
 *
 * 这里补的是「**用户显式授权的项目根**」：授权来源只有一处 ——
 * 用户在设置里亲笔写下的 `projectTests.items[].root`。模型给不出、也加不了。
 *
 * ── ★ 五条不变量 ──────────────────────────────────────────────
 *
 *   ① **默认不信任任何外部项目**。授权清单为空 → 外部根一律拒（只留隔离区那一条老路）。
 *   ② **授权根只能是用户配置里那几条**。不从参数、不从环境变量、不从模型输入取。
 *   ③ **每个根独立校验**：realpath 归一 → 拒绝盘符根/系统目录/home 根本身 →
 *      `resolveForWrite` 再挡绝对路径 / `..` / 符号链接 / 父目录越界（那条判据没改）。
 *   ④ **四种动作分别判**：读 / 测试 / 写 / 恢复各有自己的许可，写不因为能读就自动放开。
 *      · 隔离区内的根（老的 3B 用法）→ 四种全允许（它本来就是沙箱化的测试区）
 *      · 外部根 → 读/测试允许；**写/恢复要条目上显式 `allowWrite: true`**
 *   ⑤ **不把授权当沙箱**。授权根只说明「用户允许 Harbor 在这里干活」，
 *      **不**意味着测试进程有 OS 级隔离 —— 那句话必须一直摆在明面上。
 *
 * ── 为什么单列一个文件 ────────────────────────────────────────
 *
 * `codex-mcp-policy.cjs` 已 290 行（贴红线），而「哪些根算授权」是一组纯判据，
 * 自检可以喂假数据直接跑，不必起桥、不必真去建目录。
 *
 * ⚠️ 不 require electron。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 拒绝原因码（与 policy 的错误码风格一致，界面按它给人话） */
const AUTH_REASON = {
  NO_ROOT: 'PROJECT_ROOT_MISSING',
  NOT_AUTHORIZED: 'PROJECT_ROOT_NOT_AUTHORIZED',
  FORBIDDEN_ROOT: 'PROJECT_ROOT_FORBIDDEN',
  NOT_FOUND: 'PROJECT_ROOT_NOT_FOUND',
  WRITE_NOT_GRANTED: 'PROJECT_ROOT_WRITE_NOT_GRANTED',
}

/**
 * 这几种根**就算用户写了也拒**：授权一个盘符根或系统目录，等于把整台机器的
 * 任意路径都变成「已授权」。用户想授权具体项目，不该是这个。
 */
const FORBIDDEN = [
  /^[a-z]:[\\/]?$/i, // E:\
  /[\\/]windows([\\/]|$)/i, // C:\Windows / System32
  /[\\/]program files( \(x86\))?([\\/]|$)/i,
  /[\\/]programdata([\\/]|$)/i,
  /[\\/]system volume information([\\/]|$)/i,
]

/** 四种动作（写与恢复分开：恢复会写，但它只写回自己那一次，语义不同） */
const ACTIONS = ['read', 'test', 'write', 'restore']

/** 所有路径比较都先归一大小写（Windows 上 `E:\Proj` 与 `e:\proj` 是同一个目录） */
const lower = (s) => (process.platform === 'win32' ? String(s).toLowerCase() : String(s))

/** target 是否落在 root 之内（含 root 本身）—— 与 policy.isInside 同口径 */
function isInside(root, target) {
  const r = path.resolve(root)
  const t = path.resolve(target)
  if (lower(t) === lower(r)) return true
  return lower(t).startsWith(lower(r.endsWith(path.sep) ? r : r + path.sep))
}

/**
 * 把一个候选根归一成真实路径；不可达 / 形状不对 → null。
 * ★ 必须先 realpath 再比：junction / 符号链接会让字符串比较被绕过。
 */
function realRoot(candidate) {
  const text = String(candidate ?? '').trim()
  if (!text || text.includes('\0') || !path.isAbsolute(text)) return ''
  try {
    const real = fs.realpathSync(text)
    return fs.statSync(real).isDirectory() ? real : ''
  } catch {
    return ''
  }
}

/** 命中禁区？ */
function isForbidden(real) {
  return FORBIDDEN.some((re) => re.test(real))
}

/**
 * 从用户配置里取**授权清单**。
 *
 * 唯一真相源就是 `projectTests.items[].root`（用户亲笔写的那几个）——
 * 这里**不读任何别的来源**，也不接受调用方追加。
 *
 * @param {Array<{root?: string, allowWrite?: boolean}>} items
 * @param {string} isoDir 隔离数据根（`DIRS.data`）
 * @returns {Array<{ real: string, raw: string, allowWrite: boolean, isolated: boolean }>}
 */
function authorizedRoots(items, isoDir) {
  const iso = realRoot(isoDir)
  const out = []
  for (const one of Array.isArray(items) ? items : []) {
    const raw = String(one?.root ?? '').trim()
    const real = realRoot(raw)
    if (!real) continue
    /* 同一个真实目录只留一条（用户可能给同一目录配了两条测试） */
    if (out.some((x) => lower(x.real) === lower(real))) continue
    out.push({
      real,
      raw,
      /* 隔离区内的根不需要额外开关（它本来就是受控测试区） */
      isolated: Boolean(iso) && isInside(iso, real),
      allowWrite: one?.allowWrite === true,
    })
  }
  return out
}

/**
 * 判一条根能不能做某个动作。
 *
 * input = { root, isoDir, items, action? }：
 *   root   候选根（绝对路径）；isoDir 隔离数据根；
 *   items  `projectTests.items`（授权的唯一来源）；action 是四种动作之一
 *
 * @param {{ root?: string, isoDir?: string, items?: Array<any>, action?: 'read'|'test'|'write'|'restore' }} input
 * @returns {{ ok: true, abs: string, isolated: boolean } | { ok: false, code: string, message: string }}
 */
function resolveAuthorizedRoot(input) {
  const req = input && typeof input === 'object' ? input : {}
  const action = ACTIONS.includes(req.action) ? req.action : 'read'
  const raw = String(req.root ?? '').trim()
  if (!raw) return { ok: false, code: AUTH_REASON.NO_ROOT, message: '没有给出项目根' }

  const real = realRoot(raw)
  if (!real) {
    return {
      ok: false,
      code: AUTH_REASON.NOT_FOUND,
      message: `项目根不存在或不可达（必须是已存在的目录）：${raw}`,
    }
  }
  if (isForbidden(real)) {
    return {
      ok: false,
      code: AUTH_REASON.FORBIDDEN_ROOT,
      message: `这个目录不能作为项目根（盘符根 / 系统目录）：${real}`,
    }
  }

  const list = authorizedRoots(req.items, req.isoDir)
  const hit = list.find((x) => lower(x.real) === lower(real))
  if (!hit) {
    return {
      ok: false,
      code: AUTH_REASON.NOT_AUTHORIZED,
      message: `这个目录没有授权给 Harbor：${real}。要在这里干活，请在 设置 → 项目测试 里把它配成某一条测试的项目根（模型不能自己加）。`,
    }
  }

  /* 写 / 恢复：隔离区内直接放行；外部根要条目上显式 allowWrite */
  if ((action === 'write' || action === 'restore') && !hit.isolated && !hit.allowWrite) {
    return {
      ok: false,
      code: AUTH_REASON.WRITE_NOT_GRANTED,
      message: `项目根 ${real} 只授权了「读 / 跑测试」，没有授权修改。要允许 Harbor 在这里改文件，请在该测试条目上打开「允许修复写入」。`,
    }
  }

  return { ok: true, abs: real, isolated: hit.isolated }
}

/**
 * 给界面用：这条根当前能干什么（只读描述，不做判断）。
 *
 * @param {object} item 一条 projectTests 条目
 * @param {string} isoDir
 * @returns {{ ok: boolean, real: string, actions: string[], reason: string }}
 */
function describe(item, isoDir) {
  const real = realRoot(item?.root)
  if (!real) {
    return { ok: false, real: '', actions: [], reason: '目录不存在或不可达' }
  }
  if (isForbidden(real)) {
    return { ok: false, real, actions: [], reason: '盘符根 / 系统目录不能作为项目根' }
  }
  const actions = ['read', 'test']
  const iso = realRoot(isoDir)
  if ((iso && isInside(iso, real)) || item?.allowWrite === true) actions.push('write', 'restore')
  return { ok: true, real, actions, reason: '' }
}

module.exports = {
  AUTH_REASON,
  ACTIONS,
  FORBIDDEN,
  isInside,
  realRoot,
  isForbidden,
  authorizedRoots,
  resolveAuthorizedRoot,
  describe,
}
