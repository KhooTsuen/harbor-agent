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

/**
 * 当前进程是不是在跑内核自检（`node scripts/selftest.mjs`）。
 *
 * ★ 为什么靠**入口脚本路径**判断，而不是环境变量：
 *   selftest.mjs 全是静态 import（ESM 会把它们提到最前面求值），在那里写
 *   `process.env.xxx` 会晚于各测试组模块的加载 —— 想靠 env 拦根本拦不住。
 *   入口路径在**进程启动那一刻**就定死了，不存在这个时机问题。
 */
function isSelftestRun() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const expected = path.join(rootDir(), 'scripts', 'selftest.mjs').toLowerCase()
    return path.resolve(entry).toLowerCase() === expected
  } catch {
    return false
  }
}

/** 真·数据根目录 —— 永远是 <root>/data，不受自检隔离影响 */
function realDataDir() {
  return path.join(rootDir(), 'data')
}

/**
 * 当前进程是不是在跑单元测试（`vitest run`）。
 *
 * ★ 单测和自检一样要隔离：单测会 require 内核 `.cjs`（日志、配置、规模预检、
 *   导航策略…），这些模块内部直接 `log.*` → 写**应用的 data/logs**。
 *   vitest 的进程入口不是 `scripts/selftest.mjs`，`isSelftestRun()` 为 false，
 *   于是单测的假数据（`vitest-scale-*` / `dead-model` / 测试外链…）长期灌进
 *   用户真日志（2026-10-07 受控实测：跑一次 `test:unit` 主日志 +15 行）。
 *   只污染日志、不写 config/credentials，但会把排查带偏。
 *
 * ★ 这里用**环境变量**而不是入口脚本路径（与 `isSelftestRun` 不同）：vitest
 *   没法在 `test.env` 里改 `process.argv`，而 `test.env`（见 vitest.config.ts）
 *   是在 worker 启动时注入 `process.env` 的，**早于**测试模块、也就早于内核
 *   `.cjs` 被 require —— 不存在 selftest 那种「静态 import 早于赋值」的时机问题。
 */
function isUnitTestRun() {
  return process.env.HARBOR_UNIT_TEST === '1'
}

/** 隔离运行的数据目录名（自检 / 单测各一份）；不在隔离运行时返回 null */
function isolationDirName() {
  if (packaged) return null
  if (isSelftestRun()) return 'selftest-data'
  if (isUnitTestRun()) return 'unit-test-data'
  return null
}

/**
 * 数据根目录。**自检 / 单测时改到隔离目录**（`<root>/data/<隔离名>`）。
 *
 * 为什么非隔离不可：内核自检是纯 Node 环境，没有 Electron 的 `safeStorage`，
 * 而 `credentials.set()` 会把整个凭证文件的 backend 统一改成「当前后端」
 * （见 credentials.cjs）—— 它**不会**重新加密已有条目，于是原本用 safeStorage
 * 加密的 API Key 从此解不开，用户看到的就是「我填的 API 被清了」
 * （2026-10-07 真机踩中，源码版凭证据此已修复）。
 *
 * 注意 DIRS 里**派生子目录也一起走这里**（logs / sessions / events / …）——
 * 否则会出现 `DIRS.events` 与 `DIRS.data + '/events'` 指向两个地方的分裂
 * （events.cjs / task-io.cjs 等就是直接拼 `DIRS.data` 的）。
 *
 * 打包版永远走真目录（这几个分支对生产无效），只有自检 / 单测那两条命令会命中。
 */
function dataDir() {
  const iso = isolationDirName()
  return iso ? path.join(realDataDir(), iso) : realDataDir()
}

const DIRS = {
  get root() {
    return rootDir()
  },
  get data() {
    return dataDir()
  },
  get logs() {
    return path.join(dataDir(), 'logs')
  },
  get sessions() {
    return path.join(dataDir(), 'sessions')
  },
  /**
   * 技能目录。
   *
   * ★ 2026-10-07 补上隔离：原先它**刻意不隔离**（始终指真 `<root>/data/skills`），
   *   因为自检里 `73-net-policy-pin-parts` 按 `ROOT/data/skills` **硬编码**现造技能，
   *   没走 DIRS —— 贸然隔开会让验「钉到会话」的那 8 项当场红。现在那处硬编码也改成
   *   走 `DIRS.skills`，例外解除，skills 与其余子目录一样走隔离目录。
   */
  get skills() {
    return path.join(dataDir(), 'skills')
  },
  /** 头像文件（`avatar.<ext>`）—— 不进 config，见 handlers/profile.cjs */
  get avatars() {
    return path.join(dataDir(), 'avatars')
  },
  get backgrounds() {
    return path.join(dataDir(), 'backgrounds')
  },
  get workspace() {
    return path.join(dataDir(), 'workspace')
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
    return path.join(dataDir(), 'chat')
  },
  get chatCache() {
    return path.join(dataDir(), 'cache')
  },
  get crash() {
    return path.join(dataDir(), 'crash')
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
    return path.join(dataDir(), 'events')
  },
  /**
   * 错误观察哨的落点（见 error-observer.cjs）：一天一个 jsonl，只追加不覆盖。
   * 放 data 下是为了自动受「所有数据都不许在 C 盘」那条规矩管。
   */
  get errors() {
    return path.join(dataDir(), 'errors')
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
  dataDir,
  realDataDir,
  isSelftestRun,
  isUnitTestRun,
}
