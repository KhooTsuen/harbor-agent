/**
 * 真机验收用的**扩展副本**：给 manifest 临时加 `host_permissions`
 *
 * ── 为什么必须有这个让步 ────────────────────────────────────────
 *
 * 产品 manifest **刻意没有** `host_permissions`（M07：不默认要全站权限），
 * 只靠 `activeTab`。而 `activeTab` 只在**用户点工具栏图标 / 右键菜单 / 快捷键**
 * 这类真实调用时授予 —— **CDP 点不到浏览器工具栏**，所以自动化里永远拿不到。
 *
 * 2026-10-20 在**真侧栏**里实测（`probe-real-panel-read2`）：
 *
 *     chrome.tabs.query({active:true}) → url 全空
 *     read-page 返回值 → {"ok":false,"error":"读不到当前页地址 —— 先点一下工具栏的 Harbor 图标再试"}
 *     chrome.scripting.executeScript → Cannot access contents of the page.
 *         Extension manifest must request permission to access the respective host.
 *
 * 所以验收必须给**副本**临时加 `host_permissions: ['http://127.0.0.1/*']`，
 * 否则测的永远是「权限不足」而不是「业务逻辑对不对」。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────
 *
 *   ① **只在副本里加**，绝不改 `harbor-edge/extension/manifest.json`（那是产品文件）
 *   ② 只加本地回环（`http://127.0.0.1/*`）—— 验收页都跑在 127.0.0.1，不需要全站
 *   ③ 验收报告里必须**如实写**「验的是放宽了权限的副本」，并说明产品靠 activeTab；
 *      否则读者会以为产品在没有授权时也能读任意站点（那是错的，也是不安全的）
 *
 * 6 个 accept 脚本此前各写一遍同样的逻辑（口径已经开始漂：有的复制整棵目录再改
 * manifest，有的直接在副本里改 JSON）—— 收敛成这一处。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 验收页统一跑在本地回环 —— 只申请这一条，不申请全站 */
const LOOPBACK_HOST_PERMS = ['http://127.0.0.1/*']

/**
 * 把构建产物拷成可加载的副本，并给 manifest 加上本地回环的 host_permissions。
 *
 * @param {string} distDir 构建产物目录（`harbor-edge/dist/sidepanel`）
 * @param {string} stageDir 副本目录（建议落在隔离数据根下）
 * @returns {{ dir: string, hasManifest: boolean, hostPermissions: string[], productManifestUntouched: boolean }}
 */
function stageExtensionWithHostPerms(distDir, stageDir) {
  fs.rmSync(stageDir, { recursive: true, force: true })
  fs.mkdirSync(stageDir, { recursive: true })
  fs.cpSync(distDir, stageDir, { recursive: true })

  const mfPath = path.join(stageDir, 'manifest.json')
  if (!fs.existsSync(mfPath)) {
    return { dir: stageDir, hasManifest: false, hostPermissions: [], productManifestUntouched: true }
  }
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'))
  /* 只往**副本**里加；产品文件一个字节不动 */
  mf.host_permissions = [...new Set([...(mf.host_permissions ?? []), ...LOOPBACK_HOST_PERMS])]
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2), 'utf8')

  /* 复核产品文件确实没被动过：它不该有 host_permissions */
  const productPath = path.join(distDir, 'manifest.json')
  let productUntouched = true
  try {
    const product = JSON.parse(fs.readFileSync(productPath, 'utf8'))
    productUntouched = product.host_permissions === undefined
  } catch {
    productUntouched = false
  }

  return {
    dir: stageDir,
    hasManifest: true,
    hostPermissions: mf.host_permissions,
    productManifestUntouched: productUntouched,
  }
}

module.exports = { stageExtensionWithHostPerms, LOOPBACK_HOST_PERMS }
