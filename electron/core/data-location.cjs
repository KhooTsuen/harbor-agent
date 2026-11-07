/**
 * 数据目录的**位置指针**（用户可以让 Harbor 把数据放到别处）
 *
 * ── 为什么需要这个文件（不是"多一层抽象"）──────────────────────
 *
 * `config.json` 就在 `DIRS.data` 里面 —— 想从配置里读「数据在哪」必然死循环：
 * 要读配置得先知道配置在哪，要知道配置在哪得先读配置。所以「数据目录」这个
 * 决定**不能**住在配置里，只能住在一个**不需要知道 data 在哪就能算出来**的地方。
 *
 *   打包版： <exe 同级>/data-location.json
 *   源码版： <项目根>/data-location.json
 *   上面写不进去（装在 C:\Program Files 这类受保护目录）→ %LOCALAPPDATA%/Harbor/
 *
 * ── 三条纪律 ─────────────────────────────────────────────────
 *
 *   ① **没有指针 = 老行为**（`<root>/data`）。升级绝不能悄悄换目录 ——
 *      用户升级完发现"我的会话没了"，是最不能接受的一类事故。
 *   ② **指针坏了 = 当没有**：不猜、不靠半截 JSON 启动；坏的挪成 `.broken-<ts>` 留档
 *      （照 `config.cjs` 的 `.broken-<ts>` 先例，出事时能看出原来写的是什么）。
 *   ③ **本模块不 require electron**：`paths.cjs` 要用它，而 `paths.cjs` 要在
 *      纯 Node（自检 / 单测）里能跑。
 *
 * ── 指针里只存一样东西 ────────────────────────────────────────
 *
 *   `{ dataDir: '<绝对路径>', at: <毫秒> }`
 *
 *   不存"迁移状态"——那个属于一次迁移过程，住在目标目录里（见 `data-migrate.cjs`）。
 *   指针文件必须小到"写它永远不会写一半"，否则它自己就成了新的不确定性来源。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 指针文件名（放在 root 或 LOCALAPPDATA 下） */
const FILE_NAME = 'data-location.json'

/** `%LOCALAPPDATA%/Harbor` —— 受保护安装目录的兜底位置；拿不到返回空串 */
function localAppDir() {
  const base = String(process.env.LOCALAPPDATA || process.env.APPDATA || '').trim()
  return base ? path.join(base, 'Harbor') : ''
}

/**
 * 指针文件的所有候选位置（按优先级）。
 *
 * 第一个是"跟着程序走"（便携版的正确位置）；第二个是受保护安装目录的兜底。
 * 读取时**按顺序找第一个能读的**；写入时**按顺序找第一个能写的**。
 */
function candidates(root) {
  const out = [path.join(String(root ?? ''), FILE_NAME)]
  const local = localAppDir()
  if (local) out.push(path.join(local, FILE_NAME))
  return out
}

/**
 * 读指针。
 *
 * @param {string} root 程序根目录（`paths.rootDir()`）—— 由调用方给，本模块不自己算
 * @returns {{ dataDir: string, file: string, at: number } | null}
 *          没有 / 坏了 / 不是绝对路径 → `null`（调用方按"没有指针"处理）
 */
function read(root) {
  for (const file of candidates(root)) {
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      /* 这个位置没有 —— 试下一个 */
      continue
    }
    try {
      const parsed = JSON.parse(raw)
      const dir = typeof parsed?.dataDir === 'string' ? parsed.dataDir.trim() : ''
      /* 只认绝对路径：相对路径会随工作目录漂走，那正是这个模块要消灭的不确定性 */
      if (dir && path.isAbsolute(dir)) return { dataDir: dir, file, at: Number(parsed?.at) || 0 }
      throw new Error('dataDir 不是绝对路径')
    } catch (error) {
      /*
       * 坏了：留档 + 当它不存在。**不要**在这里抛 —— 指针坏掉不该让应用起不来，
       * 退回默认目录至少还能用；留档是为了事后能看出原本想指到哪。
       */
      try {
        fs.renameSync(file, `${file}.broken-${Date.now()}`)
      } catch {
        /* 连改名都失败就算了，不值得拦住启动 */
      }
      void error
    }
  }
  return null
}

/**
 * 写指针。
 *
 * @param {string} root
 * @param {string} dataDir 目标数据目录（绝对路径）
 * @returns {{ ok: boolean, file?: string, error?: string }}
 */
function write(root, dataDir) {
  const dir = String(dataDir ?? '').trim()
  if (!dir) return { ok: false, error: '没有给数据目录' }
  if (!path.isAbsolute(dir)) return { ok: false, error: '数据目录必须是绝对路径（相对路径会随启动位置漂走）' }

  const body = `${JSON.stringify({ dataDir: dir, at: Date.now() }, null, 2)}\n`
  let lastError = ''
  for (const file of candidates(root)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      /* 先写临时文件再改名：指针本身也要原子，否则断电留下半截 JSON */
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, file)
      return { ok: true, file }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: false, error: `写不进去（${lastError || '没有可用位置'}）` }
}

/**
 * 删掉所有指针 = 回到「跟着程序走」。
 *
 * 只删指针文件本身，**不删数据** —— 删数据是另一件事（那是 `data-migrate` 和
 * 用户手动的范围），这个函数绝不碰任何目录。
 */
function clear(root) {
  const removed = []
  for (const file of candidates(root)) {
    try {
      fs.rmSync(file, { force: true })
      removed.push(file)
    } catch {
      /* 删不掉就算了，下次 read 也会因为内容对不上而失效 */
    }
  }
  return { ok: true, removed }
}

/**
 * 最终用哪个数据目录。**优先级**（`paths.dataDir()` 只负责调它）：
 *
 *   ① 隔离运行（自检 / 单测 / 探针）—— 由调用方先判，不进这里
 *   ② 指针指向的目录 —— 用户主动迁过
 *   ③ 默认 `<root>/data` —— 没有指针，或指针指向的目录当前不可用
 *
 * ★ ② 为什么要判「目录真的在」：U 盘拔了 / 网盘没挂载 / 用户手工删了，就地
 *   mkdir 出一个空目录会让用户以为"数据全没了"，而数据其实好好躺在那块盘上。
 *   回退默认目录至少能启动，原因通过 `fallback` 回给调用方（诊断用）。
 *
 * @param {string} root 程序根目录
 * @param {string} defaultDir 默认数据目录（`<root>/data`）
 * @returns {{ dir: string, fallback: string, pointer: string }}
 */
function resolve(root, defaultDir) {
  const custom = read(root)
  if (!custom) return { dir: defaultDir, fallback: '', pointer: '' }

  try {
    if (fs.statSync(custom.dataDir).isDirectory()) {
      return { dir: custom.dataDir, fallback: '', pointer: custom.file }
    }
    return {
      dir: defaultDir,
      fallback: `指定的数据目录不是一个目录：${custom.dataDir}`,
      pointer: custom.file,
    }
  } catch {
    return {
      dir: defaultDir,
      fallback: `指定的数据目录当前不可用：${custom.dataDir}`,
      pointer: custom.file,
    }
  }
}

module.exports = { FILE_NAME, candidates, localAppDir, read, write, clear, resolve }
