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
const taskPresets = require('../core/task-presets.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  /*
   * 任务类型预设（②-2）：**只列出来**给界面用。
   * 类型表、推荐值、判定全在 core/task-presets.cjs —— 前端不自己算也不自己抄，
   * 两边各留一份必然漂开，而漂开之后没人知道该信哪个。
   */
  ipcMain.handle('presets:list', () => ({ ok: true, presets: taskPresets.list() }))

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

  /**
   * 会话内容加密：当前状态 + 盘上到底有多少行是密文。
   *
   * **数一遍真实文件**（而不是只报配置值）—— 配置说开着但盘上还是明文（比如上次
   * 转换中途失败），用户必须能看见，否则就是「以为加密了、其实没加」。
   */
  ipcMain.handle('security:sessionCrypto', () => {
    const sessionCrypto = require('../core/session-crypto.cjs')
    const { DIRS } = require('../core/paths.cjs')
    const fs = require('node:fs')
    const path = require('node:path')

    let files = 0
    let encrypted = 0
    let plain = 0
    try {
      for (const name of fs.readdirSync(DIRS.sessions)) {
        if (!name.endsWith('.jsonl')) continue
        files += 1
        const text = fs.readFileSync(path.join(DIRS.sessions, name), 'utf8')
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          if (line.startsWith(sessionCrypto.PREFIX)) encrypted += 1
          else plain += 1
        }
      }
    } catch (error) {
      log.warn(`统计会话加密状态失败：${error instanceof Error ? error.message : error}`)
    }

    return {
      ok: true,
      enabled: sessionCrypto.isEnabled(),
      key: sessionCrypto.keyInfo(),
      files,
      encrypted,
      plain,
    }
  })

  /**
   * 开启 / 关闭会话内容加密，**并真的转换盘上的文件**（含先备份）。
   *
   * 转换会重写用户的全部会话，所以：
   *   · 由用户显式点（不自动跑）
   *   · 内核那边先备份，备份失败就中止，一个字节都不动
   *   · 返回值里带备份名，界面要把它显示出来（出事时用户知道去哪找）
   */
  ipcMain.handle('security:setSessionCrypto', (_event, enable) => {
    const sessionCrypto = require('../core/session-crypto.cjs')
    const on = enable === true
    const result = sessionCrypto.migrate({ enable: on })

    /*
     * ★ 转换**成功之后**才写配置。
     *
     * 顺序不能反：先写配置、再转换，万一转换中途失败，配置就说「开着」而盘上还是
     * 明文 —— 之后新写的会话会被加密、老的仍是明文，用户以为全加密了。
     * 失败时配置保持原样，用户重试就行。
     */
    if (result.ok) {
      const stored = config.get().security ?? {}
      config.patch({ security: { ...stored, encryptSessions: on } })
    }

    if (result.ok) {
      log.info(`会话加密已${on ? '开启' : '关闭'}：${result.files} 个文件 / ${result.lines} 行`)
    } else {
      log.warn(`会话加密切换失败（配置未改动）：${result.error}`)
    }
    return result
  })
}

module.exports = { register }
