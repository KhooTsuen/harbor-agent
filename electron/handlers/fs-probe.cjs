const fs = require('node:fs/promises')
const path = require('node:path')
const { rootOf, resolveInside, allowedRoots } = require('./fs-root.cjs')

/** Metadata only; validate lexical and real paths without reading the file content. */
async function probeInside(target, root) {
  try {
    if (typeof target !== 'string' || !target.trim()) return { ok: false, error: '未提供文件路径' }
    const full = resolveInside(target, root)
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(full)])
    const rel = path.relative(realRoot, realFile)
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return { ok: false, error: '文件实际位置超出此会话的工作目录' }
    }
    const stat = await fs.stat(realFile)
    return { ok: true, exists: true, file: stat.isFile(), size: stat.size, path: realFile }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: true, exists: false }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function probe(target, requestedRoot) {
  try {
    let root
    if (requestedRoot) {
      const resolved = path.resolve(requestedRoot)
      const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      if (!allowedRoots().has(normalized))
        return { ok: false, error: '此会话的工作目录目前不可访问' }
      root = resolved
    } else root = rootOf()
    return await probeInside(target, root)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function register({ ipcMain }) {
  ipcMain.handle('fs:probe', (_event, target, root) => probe(target, root))
}

module.exports = { register, probe, probeInside }
