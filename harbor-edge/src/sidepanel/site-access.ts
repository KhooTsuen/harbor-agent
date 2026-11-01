/**
 * M07 扩展侧：**可选整站读取权限**（2026-10-21）
 *
 * ── 它解决什么 ────────────────────────────────────────────────
 * 产品默认只要 `activeTab`（M07 最小权限）：**用户点图标 → 只授权当前这一个标签**，
 * 换标签就得重新点。2026-10-21 用户拍板：默认仍最小权限，但给两个主动扩大的入口 ——
 *   · 设置抽屉「整站读取」  → 授权所有站点（`<all_urls>`）
 *   · 网页卡「记住本页」    → 只授权当前这一个域名（`https://a.com/*`）
 * 两者共用**同一套机制**（manifest 的 `optional_host_permissions`），只是 origin 范围不同。
 *
 * ── ★ 四条不能违反的 ──────────────────────────────────────────
 *
 * ① **`request()` 必须在用户手势的调用栈里**。前面多一个 `await` 就会丢手势，
 *    抛 `This function must be called during a user gesture`。
 *    所以「申请」拆成独立函数，调用方在 onClick 里**第一个**调它，别先 await 别的东西。
 * ② **绝不动 manifest 的 `permissions` / `host_permissions`** —— 177 组自检钉着
 *    「默认 host_permissions 为空」。这里只碰 `optional_host_permissions`（安装时不弹窗）。
 * ③ **「能读」与「允许读」是两件事**：本文件只管前者（浏览器层面够不够得着）。
 *    后者（站点黑名单）永远在主进程 `ext-sites.cjs`，这里不复制一份判定。
 * ④ 撤销失败如实返回 false，不装作成功。
 *
 * ── ⚠️ 为什么这里没有编译期类型检查 ────────────────────────────
 * `tsconfig.json` 的 include 只有 `["src", "vite.config.ts"]`，`harbor-edge/` 不在其中；
 * 项目也没装 `@types/chrome`。所以 `chrome.permissions.*` 写错属性名**不会有 tsc 报错**，
 * 只能靠 `scripts/selftest/groups/177-m02c-settings.mjs`（跑本文件的纯函数）+ 真机。
 */

/** 可选权限里「所有站点」的写法（必须与 manifest 的 `optional_host_permissions` 一致） */
export const ALL_SITES = '<all_urls>'

/**
 * 只取我们真用到的那三个方法（没装 @types/chrome，自己声明最小形状 —— 不用 any）。
 *
 * 形状照 Chrome 官方：三者都收 `{ origins?: string[] }`、都返回 `Promise<boolean>`。
 */
export interface PermissionsApi {
  request(permissions: { origins?: string[] }): Promise<boolean>
  remove(permissions: { origins?: string[] }): Promise<boolean>
  contains(permissions: { origins?: string[] }): Promise<boolean>
}

/** 拿 permissions API；不是扩展环境（自检 / 浏览器预览）时返回 null，不抛 */
function api(): PermissionsApi | null {
  const g = globalThis as unknown as { chrome?: { permissions?: PermissionsApi } }
  const p = g.chrome?.permissions
  return p && typeof p.request === 'function' ? p : null
}

/**
 * URL → 宿主权限模式（`https://a.com/x` → `https://a.com/*`）。
 *
 * 给不出就返回空串（调用方据此**不申请**，而不是申请一个 `/*` 出去）。
 *
 * ★ 为什么用 `hostname` 而不是 `host`：match pattern 的 host 段**不带端口**；
 *   用 `host` 会把 `localhost:3000` 拼进去，Edge 那边认不出来。
 * ★ IPv6（`[::1]`）的 hostname 含冒号，match pattern 里要转义，这里**不做** ——
 *   走「整站读取」那条路即可，别为它留一条没验过的分支。
 */
export function originPatternOf(url: string): string {
  const text = String(url ?? '').trim()
  if (!text) return ''
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  const host = String(parsed.hostname ?? '')
  if (!host || host.includes(':')) return ''
  return `${parsed.protocol}//${host}/*`
}

/** 是否已授权**所有**站点 */
export async function hasAllSites(): Promise<boolean> {
  const p = api()
  if (!p) return false
  try {
    return (await p.contains({ origins: [ALL_SITES] })) === true
  } catch {
    return false
  }
}

/**
 * 这个 url 所在的站点是否已在授权范围内。
 *
 * 已授权 `<all_urls>` 时对任何具体 origin 也会返回 true（浏览器就是这么算的）——
 * 所以界面不需要自己再判一次「是不是整站授权」。
 */
export async function hasAccessTo(url: string): Promise<boolean> {
  const pattern = originPatternOf(url)
  if (!pattern) return false
  const p = api()
  if (!p) return false
  try {
    return (await p.contains({ origins: [pattern] })) === true
  } catch {
    return false
  }
}

/**
 * 申请**所有站点**（会弹 Edge 原生授权框）。
 *
 * ⚠️ 必须在 onClick 的调用栈里**第一个** await 它。失败通常是丢了用户手势或用户点了取消，
 *    两种都不该自动重试（重试只会再弹一次框骚扰他）。
 */
export async function requestAllSites(): Promise<boolean> {
  const p = api()
  if (!p) return false
  try {
    return (await p.request({ origins: [ALL_SITES] })) === true
  } catch {
    return false
  }
}

/** 申请**当前这一个站点**（会弹 Edge 原生授权框，框上只写这个域名） */
export async function requestSite(url: string): Promise<boolean> {
  const pattern = originPatternOf(url)
  if (!pattern) return false
  const p = api()
  if (!p) return false
  try {
    return (await p.request({ origins: [pattern] })) === true
  } catch {
    return false
  }
}

/** 撤销「所有站点」授权（不需要用户手势） */
export async function removeAllSites(): Promise<boolean> {
  const p = api()
  if (!p) return false
  try {
    return (await p.remove({ origins: [ALL_SITES] })) === true
  } catch {
    return false
  }
}

/**
 * 撤销**某个站点**的授权。
 *
 * ★ 只对「按站点记住」来的授权有效。若用户开的是整站读取，撤销单个站点不会有反应 ——
 *   那是浏览器语义（整站授权还在，具体 origin 自然仍被覆盖），界面要把这句说清。
 */
export async function removeSiteAccess(url: string): Promise<boolean> {
  const pattern = originPatternOf(url)
  if (!pattern) return false
  const p = api()
  if (!p) return false
  try {
    return (await p.remove({ origins: [pattern] })) === true
  } catch {
    return false
  }
}
