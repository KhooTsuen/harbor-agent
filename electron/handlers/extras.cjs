/**
 * 记忆 / 搜索 / MCP 的 IPC
 *
 * 这三块都放在一个文件里：各只有两三个 handler，
 * 拆成三个文件反而难找。
 */

const memory = require('../core/memory.cjs')
const search = require('../core/search.cjs')
const mcp = require('../core/mcp.cjs')
const mcpPresets = require('../core/mcp-presets.cjs')
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
      type: options.type ?? '',
      projectId: options.projectId ?? '',
      includeSuperseded: options.includeSuperseded === true,
    }),
  }))

  ipcMain.handle('memory:search', (_event, payload) => ({
    ok: true,
    items: memory.search(String(payload?.query ?? ''), {
      projectId: String(payload?.projectId ?? ''),
      includeSuperseded: payload?.includeSuperseded === true,
    }),
  }))

  /**
   * 「记忆为什么是这样」—— 设置页要显示的两样东西。
   *
   * ① `injected`：上一轮注入账（哪几条真的进了系统提示、各多少分、分是怎么来的）。
   *    进程内状态、不落盘 → 刚启动时是 null，界面必须能处理。
   * ② `items`：当前 active 记忆逐条打分的解释。检索**没开**（`memory.retrieve`
   *    为 false）时全量注入，排序没有意义，所以那时返回空数组而不是编一个分数。
   */
  ipcMain.handle('memory:explain', (_event, options = {}) => {
    const query = String(options?.query ?? '')
    const last = memory.lastInjection()
    const retrieveOn = config.get().memory.retrieve !== false
    const items = retrieveOn
      ? memory
          .list({ status: 'active', projectId: options?.projectId ?? '' })
          .map((item) => {
            const scored = memory.explain(item, { query })
            return {
              id: item.id,
              content: item.content,
              type: item.type,
              scope: item.scope,
              score: scored.score,
              reason: memory.explainSummary(scored),
            }
          })
          .sort((a, b) => b.score - a.score)
      : []

    return { ok: true, injected: last, items, retrieveEnabled: retrieveOn }
  })

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
      /* 测连通性：用 fresh 跳过缓存，不然「测试」永远拿旧结果，看不出现在通不通 */
      const found = await search.search('hello world', {
        provider: merged.provider,
        apiKey,
        endpoint: merged.endpoint,
        maxResults: 3,
        fresh: true,
      })
      return { ok: true, count: found.results.length, sample: found.results[0]?.title ?? '' }
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

  /* 内置预设：界面拿它做「一键添加」，命令模板唯一真相源在内核（mcp-presets.cjs） */
  ipcMain.handle('mcp:presets', () => {
    /* 占位符在这里填（工作目录只有内核知道），界面直接拿现成的命令行 */
    const dir = config.get().general?.workdir ?? ''
    return mcpPresets.list().map((p) => ({ ...p, command: mcpPresets.fillCommand(p, { dir }) }))
  })

  /** 重启所有 MCP 服务器（改了配置之后用） */
  ipcMain.handle('mcp:restart', async () => {
    const servers = config.get().mcp.servers
    const result = await mcp.startAll(servers)
    log.info(`MCP 重启完成，${result.length} 个服务器`)
    return { ok: true, servers: result }
  })

  /**
   * 网络策略：当前值 + 一段「管得到 / 管不到什么」的说明。
   *
   * `description` **由内核生成**（`net-policy.describePolicy`），不在前端拼 ——
   * 那段话是交付内容的一部分：它说清了这个开关的边界，前端重写一遍就会漂，
   * 而且漂的方向通常是「说得比实际强」。
   */
  ipcMain.handle('security:network', () => {
    const netPolicy = require('../core/net-policy.cjs')
    const stored = config.get().security?.network ?? {}
    return {
      ok: true,
      mode: stored.mode ?? 'ask',
      denyHosts: [...(stored.denyHosts ?? [])],
      allowHosts: [...(stored.allowHosts ?? [])],
      description: netPolicy.describePolicy(),
    }
  })
}

module.exports = { register }
