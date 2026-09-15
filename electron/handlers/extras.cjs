/**
 * 记忆 / 搜索 / MCP 的 IPC
 *
 * 这三块都放在一个文件里：各只有两三个 handler，
 * 拆成三个文件反而难找。
 */

const memory = require('../core/memory.cjs')
const search = require('../core/search.cjs')
const mcp = require('../core/mcp.cjs')
const config = require('../core/config.cjs')
const stats = require('../core/stats.cjs')
const backup = require('../core/backup.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  /* ── 记忆 ─────────────────────────────────────────────── */

  /* 结构化记忆：列表 / 增改删 / 搜索 */
  ipcMain.handle('memory:list', (_event, options = {}) => ({
    ok: true,
    items: memory.list({
      status: options.status ?? '',
      scope: options.scope ?? '',
      type: options.type ?? '',
      includeSuperseded: options.includeSuperseded === true,
    }),
  }))

  ipcMain.handle('memory:search', (_event, query) => ({
    ok: true,
    items: memory.search(String(query ?? '')),
  }))

  ipcMain.handle('memory:add', (_event, input) => {
    const result = memory.add(input ?? {})
    return result.ok ? { ok: true, item: result.item, stats: memory.stats() } : result
  })

  ipcMain.handle('memory:update', (_event, payload = {}) => {
    const result = memory.update(String(payload.id ?? ''), payload.patch ?? {})
    return result.ok ? { ok: true, item: result.item, stats: memory.stats() } : result
  })

  ipcMain.handle('memory:disable', (_event, id) => memory.disable(String(id ?? '')))

  ipcMain.handle('memory:enable', (_event, id) => memory.enable(String(id ?? '')))

  ipcMain.handle('memory:remove', (_event, id) => {
    const result = memory.remove(String(id ?? ''))
    return { ...result, stats: memory.stats() }
  })

  ipcMain.handle('memory:get', () => ({
    text: memory.read(),
    stats: memory.stats(),
    path: memory.memoryFile(),
  }))

  ipcMain.handle('memory:set', (_event, text) => {
    const result = memory.write(text)
    return result.ok ? { ok: true, stats: memory.stats() } : result
  })

  ipcMain.handle('memory:clear', () => {
    memory.clear()
    log.info('记忆已清空')
    return { ok: true, stats: memory.stats() }
  })

  /* ── 搜索 ─────────────────────────────────────────────── */

  ipcMain.handle('search:providers', () => search.providerList())

  /** 测试搜索配置：拿一个简单词试一下，把错误原样带回来 */
  ipcMain.handle('search:test', async (_event, override) => {
    const current = config.get().search
    const merged = { ...current, ...(override ?? {}) }
    /* 掩码说明「没改」，用库里那把；填了新值就直接用它试 */
    const typed = merged.apiKey && merged.apiKey !== '••••••••' ? merged.apiKey : ''
    const apiKey = typed || config.searchKey()
    try {
      const results = await search.search('hello world', {
        provider: merged.provider,
        apiKey,
        endpoint: merged.endpoint,
        maxResults: 3,
      })
      return { ok: true, count: results.length, sample: results[0]?.title ?? '' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /* ── 用量统计 ─────────────────────────────────────────── */

  ipcMain.handle('stats:summary', () => stats.summary())
  ipcMain.handle('stats:reset', () => {
    const result = stats.reset()
    return { ...result, summary: stats.summary() }
  })

  /* ── 备份 ─────────────────────────────────────────────── */

  ipcMain.handle('backup:list', () => backup.list())
  ipcMain.handle('backup:create', () => backup.create('manual'))
  ipcMain.handle('backup:restore', (_event, name) => backup.restore(String(name)))
  ipcMain.handle('backup:remove', (_event, name) => backup.remove(String(name)))
  ipcMain.handle('backup:open', async () => {
    try {
      const { shell } = require('electron')
      await shell.openPath(backup.root())
      return { ok: true, path: backup.root() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /* ── MCP ──────────────────────────────────────────────── */

  ipcMain.handle('mcp:status', () => mcp.status())

  /** 重启所有 MCP 服务器（改了配置之后用） */
  ipcMain.handle('mcp:restart', async () => {
    const servers = config.get().mcp.servers
    const result = await mcp.startAll(servers)
    log.info(`MCP 重启完成，${result.length} 个服务器`)
    return { ok: true, servers: result }
  })
}

module.exports = { register }
