/**
 * 路径与数据目录
 *
 * 硬规则（沿用参考实现的约定，用户 C 盘紧张）：
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
  get chatCache() {
    return path.join(rootDir(), 'data', 'cache')
  },
  get crash() {
    return path.join(rootDir(), 'data', 'crash')
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
    DIRS.chatCache,
    DIRS.crash,
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
