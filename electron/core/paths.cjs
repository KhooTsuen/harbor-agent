/**
 * 路径与数据目录
 *
 * 硬规则（数据一律落在程序自己旁边，不碰系统盘）：
 *   **任何数据都落在 <根>/data 下，绝不写 C 盘。**
 *
 * 开发时：<项目>/data
 * 打包后：<exe 同级>/data   ← 整个文件夹可以搬走
 *
 * 这个模块刻意 **不 require('electron')**，这样能被单元测试直接跑。
 */

const path = require('node:path')
const fs = require('node:fs')

/** 是否运行在打包后的便携版里（由 main.cjs 在启动时设置） */
let packaged = false
/** 打包态的基准目录（exe 所在目录） */
let packagedBase = ''

function markPackaged(baseDir) {
  packaged = true
  packagedBase = baseDir
}

function rootDir() {
  if (packaged) return packagedBase
  /* electron/ 的上一层就是项目根 */
  return path.resolve(__dirname, '..', '..')
}

const DIRS = {
  get root() {
    return rootDir()
  },
  get data() {
    return path.join(rootDir(), 'data')
  },
  get logs() {
    return path.join(rootDir(), 'data', 'logs')
  },
  get sessions() {
    return path.join(rootDir(), 'data', 'sessions')
  },
  get skills() {
    return path.join(rootDir(), 'data', 'skills')
  },
  /** 头像文件（`avatar.<ext>`）—— 不进 config，见 handlers/profile.cjs */
  get avatars() {
    return path.join(rootDir(), 'data', 'avatars')
  },
  get backgrounds() {
    return path.join(rootDir(), 'data', 'backgrounds')
  },
  get workspace() {
    return path.join(rootDir(), 'data', 'workspace')
  },
  /**
   * 默认**对话目录**（2026-10-05 用户拍板：默认位置改成这里）。
   *
   * 和 workspace 的区别是"叫什么"而不是"干什么"：workspace 是历史包袱 ——
   * 名字含义太泛（工作区？工作目录？）而实际只当对话的落地点用。
   * 老装机里 workspace 已经有东西的话**继续用它**（见 handlers/workdir.cjs），
   * 不搬文件、不改 config，不让人升级完就找不到东西。
   */
  get chat() {
    return path.join(rootDir(), 'data', 'chat')
  },
  get chatCache() {
    return path.join(rootDir(), 'data', 'cache')
  },
  get crash() {
    return path.join(rootDir(), 'data', 'crash')
  },
  /**
   * 事件流落点（见 `events.cjs`）：一天一个 jsonl，只追加不覆盖。
   *
   * ★ 2026-10-04 才补上：以前 `DIRS` 里**没有这个键**（目录是 events 自己 lazily 建的），
   *   于是第 4 批的保留期那句 `DIRS.events` 读到 `undefined` → `readdirSync(undefined)` 抛
   *   → 被 catch 成「目录还不存在」→ **静默什么都没做**。单测看不出来（它自己传目录），
   *   是真机探针摆好旧文件、发现一个都没删才逮住的。
   */
  get events() {
    return path.join(rootDir(), 'data', 'events')
  },
  /**
   * 错误观察哨的落点（见 error-observer.cjs）：一天一个 jsonl，只追加不覆盖。
   * 放 data 下是为了自动受「所有数据都不许在 C 盘」那条规矩管。
   */
  get errors() {
    return path.join(rootDir(), 'data', 'errors')
  },
}

/** 把 data 下面该有的目录都建出来 */
function ensureDirs() {
  const list = [
    DIRS.data,
    DIRS.logs,
    DIRS.sessions,
    DIRS.skills,
    DIRS.avatars,
    DIRS.backgrounds,
    DIRS.workspace,
    DIRS.chat,
    DIRS.chatCache,
    DIRS.crash,
    DIRS.errors,
    DIRS.events,
  ]
  for (const dir of list) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return list
}

/** 配置文件路径 */
function configFile() {
  return path.join(DIRS.data, 'config.json')
}

/**
 * 检查所有数据目录是否都在 C 盘之外。
 * 自检和启动时都会调，写错了能立刻发现。
 */
function auditNonC() {
  const results = []
  const list = [
    ['运行数据', DIRS.data],
    ['日志', DIRS.logs],
    ['会话', DIRS.sessions],
    ['工作目录', DIRS.workspace],
    ['对话目录', DIRS.chat],
  ]
  for (const [label, dir] of list) {
    const normalized = path.resolve(dir).toLowerCase()
    results.push({
      label,
      dir,
      ok: !normalized.startsWith('c:\\'),
    })
  }
  return results
}

module.exports = {
  DIRS,
  ensureDirs,
  configFile,
  auditNonC,
  markPackaged,
  rootDir,
}
