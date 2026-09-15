/**
 * 插件热插拔（「即插即用」的核心）
 *
 * 监听 data/plugins/ 目录，有增/删/改就**防抖后自动重扫**：
 *   丢一个插件文件夹进去 → 下一轮对话模型立刻能看到
 *   删掉 → 立刻从工具清单消失
 * 不用重启宿主。
 *
 * 为什么是「目录监听」而不是别的：
 *   插件就是宿主机上的一个目录。宿主盯着这个目录，等价于 Cordis 内核的
 *   mount/unmount —— 只是用文件系统的增删来表达「挂载/卸载」。
 *
 * Windows 上 fs.watch 的坑：
 *   目录内的增删改可能**连续触发多次**（rename 事件尤其），所以必须防抖；
 *   不防抖的话，拷一个插件进来会触发好几轮重扫，日志刷屏还不稳定。
 */

const fs = require('node:fs')
const log = require('./log.cjs')
const plugins = require('./plugins.cjs')
const registry = require('./tools/registry.cjs')

/** 当前插件名集合（diff 用） */
let lastNames = null

function snapshot() {
  return new Set(plugins.list().map((p) => p.name))
}

/** 纯函数：算增删（给测试用） */
function diff(prev, next) {
  const added = [...next].filter((n) => !prev.has(n))
  const removed = [...prev].filter((n) => !next.has(n))
  return { added, removed }
}

/**
 * 启动热插拔监听。返回 stop 函数。
 *
 * @param {{ onChanged?: (change: { added: string[], removed: string[], count: number }) => void }} options
 */
function start(options = {}) {
  const dir = plugins.pluginsDir()
  fs.mkdirSync(dir, { recursive: true })
  lastNames = snapshot()

  const onChanged = options.onChanged ?? (() => {})

  let timer = null
  let closed = false
  let watcher = null

  try {
    watcher = fs.watch(dir, { persistent: false }, () => {
      if (closed) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (closed) return
        registry.reloadPlugins()
        const next = snapshot()
        const { added, removed } = diff(lastNames, next)
        lastNames = next
        if (added.length > 0 || removed.length > 0) {
          log.info(`插件热插拔：+${added.length} / -${removed.length}（现 ${next.size} 个）`)
          onChanged({ added, removed, count: next.size })
        }
      }, 500)
    })
    watcher.on('error', (err) => {
      log.warn(`插件目录监听出错：${err?.message ?? err}`)
    })
  } catch (error) {
    log.warn(`无法监听插件目录（${dir}）：${error instanceof Error ? error.message : error}`)
  }

  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    try {
      watcher?.close()
    } catch {
      /* 已经关了 */
    }
  }
}

/** 便捷入口：装到 main.cjs，onChanged 里发 'plugins:changed' 事件给前端 */
function install({ send }) {
  return start({
    onChanged: (change) => {
      if (typeof send === 'function') send('plugins:changed', change)
    },
  })
}

module.exports = { start, install, snapshot, diff }
