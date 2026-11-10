/**
 * 凭证库的**维护动作**：明文升级（第 17 项）+ 诊断状态
 *
 * 为什么单独一个文件：`credentials.cjs` 顶在 300 行红线上，而这两块要用的
 * 依赖（load / commit / decrypt / encrypt / 留档 / 健康态）全在那边。所以这里
 * **不持有任何模块状态**，由工厂接收依赖 —— 唯一持有 cache / backend / health
 * 的仍然是 `credentials.cjs`，判据没有第二份（硬约束 9）。
 *
 * `upgrade` 与 `reset` 的区别：reset 是**清空重来**（破坏性、要 confirm），
 * upgrade 是**保数据**的原地升级。所以同样先留档，留不下就中止，原文件一字节不动。
 */

/**
 * @param {{
 *   load: () => { backend: string, entries: Record<string, { value: string, updatedAt?: number }> },
 *   assertWritable: () => void,
 *   encryptionAvailable: () => boolean,
 *   filePath: () => string,
 *   keepCorruptCopy: (file: string) => string,
 *   decrypt: (entry: object, backend: string) => string,
 *   encrypt: (plain: string, backend: string) => { value: string },
 *   commit: (next: object) => void,
 * }} deps
 */
function createUpgrader(deps) {
  return function upgrade() {
    const data = deps.load()
    deps.assertWritable()
    if (data.backend === 'safeStorage') {
      return { ok: true, upgraded: 0, backend: 'safeStorage', reason: '已经是系统加密，无需升级' }
    }
    if (!deps.encryptionAvailable()) {
      throw new Error('本机拿不到系统加密能力（safeStorage 不可用）—— 这台机器上升级不了')
    }
    const refs = Object.keys(data.entries)
    if (refs.length === 0) return { ok: true, upgraded: 0, backend: data.backend, reason: '库里没有凭证' }
    const file = deps.filePath()
    const archived = deps.keepCorruptCopy(file)
    if (!archived) {
      throw new Error(`留档失败，已中止升级（原文件未改动）：${file}。请检查磁盘空间 / 权限。`)
    }
    const next = { version: 1, backend: 'safeStorage', entries: {} }
    for (const [ref, entry] of Object.entries(data.entries)) {
      const plain = deps.decrypt(entry, data.backend)
      if (!plain) continue
      next.entries[ref] = {
        value: deps.encrypt(plain, 'safeStorage').value,
        updatedAt: entry?.updatedAt ?? Date.now(),
      }
    }
    deps.commit(next)
    return { ok: true, upgraded: Object.keys(next.entries).length, backend: 'safeStorage', archived }
  }
}

/**
 * 诊断状态。`plainOnDisk` / `canUpgrade` 是给界面用的（第 17 项）：
 * 只看 `encryptionAvailable` 会把「盘上是明文」误报成「已用系统加密」。
 *
 * @param {{
 *   load: () => { backend: string, entries: object },
 *   encryptionAvailable: () => boolean,
 *   filePath: () => string,
 *   healthOf: () => { health: string, healthError: string },
 * }} deps
 */
function createStatus(deps) {
  return function status() {
    const data = deps.load()
    const count = Object.keys(data.entries).length
    const plain = data.backend !== 'safeStorage'
    const { health, healthError } = deps.healthOf()
    return {
      encryptionAvailable: deps.encryptionAvailable(),
      backend: data.backend,
      plainOnDisk: plain && count > 0,
      canUpgrade: plain && count > 0 && deps.encryptionAvailable(),
      count,
      file: deps.filePath(),
      health,
      healthError,
    }
  }
}

module.exports = { createUpgrader, createStatus }
