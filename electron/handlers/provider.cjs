/**
 * IPC：供应商
 *
 * 从 main.cjs 拆出来的（那边过 300 行了）。两个通道：
 *   · 测连接 —— 设置页点「测试」时用
 *   · 拉模型清单 —— 让用户从下拉里挑，而不是手打模型名
 *
 * 两个都必须先确认「有供应商、填了 baseUrl、有 Key」，否则报出来的
 * 全是 fetch failed 之类看不懂的东西。
 */

const config = require('../core/config.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  /* ── 供应商测连接 ───────────────────────────────────────── */
  ipcMain.handle('provider:ping', async (_event, providerId) => {
    const llm = require('../core/llm.cjs')
    const all = config.get().providers
    const target = providerId ? all.find((p) => p.id === providerId) : config.activeProvider()
    if (!target) return { ok: false, error: '没有可用的供应商' }
    if (!config.hasKey(target)) return { ok: false, error: '这个供应商还没填 API Key' }

    try {
      const result = await llm.ping({
        baseUrl: target.baseUrl,
        apiKey: config.providerKey(target),
        chatPath: target.chatPath,
        model: target.models[0] ?? config.get().assistant.model,
      })
      return result
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /* ── 拉取供应商的模型清单 ───────────────────────────────── */

  ipcMain.handle('provider:listModels', async (_event, providerId) => {
    const llm = require('../core/llm.cjs')
    const all = config.get().providers
    const target = providerId ? all.find((p) => p.id === providerId) : config.activeProvider()
    if (!target) return { ok: false, error: '没有可用的供应商' }
    if (!target.baseUrl) return { ok: false, error: '这个供应商还没填接口地址' }
    if (!config.hasKey(target)) return { ok: false, error: `${target.name} 还没填 API Key` }

    try {
      const result = await llm.listModels({
        baseUrl: target.baseUrl,
        apiKey: config.providerKey(target),
      })
      if (result.ok) log.info(`拉取模型清单：${target.id} 得到 ${result.models.length} 个`)
      return result
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

module.exports = { register }
