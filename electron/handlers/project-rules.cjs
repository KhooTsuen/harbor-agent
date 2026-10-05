/**
 * IPC：项目级规则（`<工作目录>/.harbor/rules.md`）
 *
 * 三条通道，都很薄 —— 逻辑在 `core/project-rules.cjs`，这里只做「解析目录」
 * 和「需要 electron 的那两件事（打开 / 创建后打开）」：
 *
 *   · `projectRules:status`  只读状态：文件在不在、多大、缓存有没有过期
 *   · `projectRules:reload`  显式重新加载（跳过 mtime 缓存）→ 点了立即生效
 *   · `projectRules:open`    在系统默认程序里打开；`create: true` 时先按骨架建一个
 *
 * ⚠️ 路径安全靠的是**只构造、不采信**：传进来的是「哪个目录」，我们只会碰它下面的
 *    `.harbor/rules.md` 与 `.harbor/rules/*.md` —— 从不接受「要打开哪个文件」这种参数，
 *    所以构造不出工作目录之外的目标。
 *    （不能用 `fs.cjs` 的 `resolveInside`：那个只认**全局**工作目录，而每条对话、
 *      每个文件夹各有各的目录，这里要按对话解析。）
 *
 * ⚠️ `require('electron')` 只出现在函数体里（不在模块顶层）：自检会在没有 Electron 的
 *    Node 里加载 handler，顶层 require 会让那个文件直接加载不了。
 */

const fs = require('node:fs')
const path = require('node:path')
const rules = require('../core/project-rules.cjs')
const log = require('../core/log.cjs')
const { resolveWorkdir } = require('./workdir.cjs')

const err = (error) => (error instanceof Error ? error.message : String(error))

/** 应用内编辑的大小上限（编辑器是个 textarea，再大界面就卡死了） */
const MAX_EDIT_BYTES = 512 * 1024

/** 传进来的目录不可用（被删/被拔）就回落到默认工作目录 —— 和别的通道一个口径 */
function dirOf(input) {
  const requested = typeof input?.dir === 'string' ? input.dir : ''
  return resolveWorkdir(requested)
}

/** 规则主文件的绝对路径（**由我们拼出来**，不接受外部指定文件名） */
function mainFile(dir) {
  return path.join(dir, rules.DIR, rules.MAIN)
}

/** 给界面的一份状态：内核状态 + 「文件到底在哪」 */
function snapshot(dir) {
  const status = rules.status({ workdir: dir })
  return { ...status, file: mainFile(dir), exists: fs.existsSync(mainFile(dir)) }
}

function register({ ipcMain }) {
  ipcMain.handle('projectRules:status', (_event, input = {}) => {
    try {
      return { ok: true, ...snapshot(dirOf(input)) }
    } catch (error) {
      return { ok: false, error: err(error) }
    }
  })

  ipcMain.handle('projectRules:reload', (_event, input = {}) => {
    try {
      const dir = dirOf(input)
      /* force：跳过缓存。这一步是「我改了文件，现在就要它生效」 */
      const loaded = rules.load(dir, { force: true })
      log.info(
        `项目规则重新加载：${loaded.files.length} 个文件 · ${loaded.bytes} 字节${
          loaded.truncated ? '（超上限已截断）' : ''
        }`,
      )
      return {
        ok: true,
        ...snapshot(dir),
        reloaded: loaded.reloaded,
        files: loaded.files.map((item) => item.relative),
        bytes: loaded.bytes,
        truncated: loaded.truncated,
        errors: loaded.errors,
      }
    } catch (error) {
      return { ok: false, error: err(error) }
    }
  })

  ipcMain.handle('projectRules:open', async (_event, input = {}) => {
    try {
      const dir = dirOf(input)
      const file = mainFile(dir)

      if (input?.create === true && !fs.existsSync(file)) {
        const made = rules.create({ workdir: dir })
        /* 已经存在不算失败（用户可能刚建过），其余错误照实说 */
        if (!made.ok && made.error !== '规则文件已经存在') return made
        log.info(`已创建项目规则：${made.relative ?? rules.DIR + '/' + rules.MAIN}`)
      }
      if (!fs.existsSync(file)) {
        return { ok: false, error: `还没有规则文件（${rules.DIR}/${rules.MAIN}）`, file }
      }

      const { shell } = require('electron')
      /* openPath 成功返回空串，失败返回**人话原因**（没有关联程序、没权限…） */
      const problem = await shell.openPath(file)
      return problem ? { ok: false, error: problem, file } : { ok: true, file }
    } catch (error) {
      return { ok: false, error: err(error) }
    }
  })

  /*
   * ── 应用内编辑（真机反馈 10）────────────────────────────────
   *
   * 以前只能「在系统编辑器里打开」，改完还得回来点一次重新加载。
   * 现在设置页里直接改 —— 但**边界一点没放松**：
   *
   * ★ 参数是 `target`（一个符号：`'rules'` / `'agent'`），**不是路径**。
   *   文件路径由内核自己拼，所以「要编辑哪个文件」在协议层就**构造不出来** ——
   *   比「收一个路径再校验白名单」更难写错（那个要求白名单本身写对，这个不需要）。
   *   与 `projectRules:open` 同一个思路：只构造、不采信。
   */
  const editors = {
    rules: (dir) => mainFile(dir),
    agent: (dir) => path.join(dir, 'AGENT.md'),
  }

  const fileFor = (dir, target) => {
    const pick = editors[target]
    if (!pick) throw new Error(`不认识的编辑目标：${String(target)}（只支持 rules / agent）`)
    return pick(dir)
  }

  ipcMain.handle('projectRules:readFile', (_event, input = {}) => {
    try {
      const dir = dirOf(input)
      const file = fileFor(dir, input?.target)
      if (!fs.existsSync(file)) return { ok: true, file, exists: false, content: '' }

      const stat = fs.statSync(file)
      if (stat.size > MAX_EDIT_BYTES) {
        const kb = Math.round(stat.size / 1024)
        const cap = Math.round(MAX_EDIT_BYTES / 1024)
        return {
          ok: false,
          file,
          error: `文件 ${kb} KB，超过应用内编辑的 ${cap} KB 上限 —— 用「在系统编辑器里打开」改它`,
        }
      }
      return {
        ok: true,
        file,
        exists: true,
        content: fs.readFileSync(file, 'utf8'),
        mtime: stat.mtimeMs,
      }
    } catch (error) {
      return { ok: false, error: err(error) }
    }
  })

  ipcMain.handle('projectRules:writeFile', (_event, input = {}) => {
    try {
      const dir = dirOf(input)
      const target = String(input?.target ?? '')
      const file = fileFor(dir, target)
      const text = String(input?.content ?? '')
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > MAX_EDIT_BYTES) {
        return { ok: false, error: `内容太大（${Math.round(bytes / 1024)} KB），没保存` }
      }

      fs.mkdirSync(path.dirname(file), { recursive: true })
      /* 原子写 —— Windows 上目标被占着时 rename 会 EPERM，safe-write 那边有退避重试 */
      require('../core/safe-write.cjs').writeAtomic(file, text)

      /*
       * 审计：改项目规则会**影响之后每一轮对话**，必须留痕。
       * 权限档写 `ui` —— 它不在工具调用链上，但同样要能事后查到。
       */
      try {
        require('../core/audit.cjs').record({
          tool: 'edit_project_rules',
          args: { target, file, bytes },
          permission: 'ui',
          approval: true,
          ok: true,
          affectedFiles: [file],
        })
      } catch {
        /* 审计不影响写入 */
      }

      /* 规则文件改完立刻生效（跳过 mtime 缓存）；AGENT.md 下一轮自然重读 */
      if (target === 'rules') rules.load(dir, { force: true })

      log.info(`应用内编辑：${file}（${bytes} 字节）`)
      return { ok: true, file, bytes }
    } catch (error) {
      return { ok: false, error: err(error) }
    }
  })
}

module.exports = { register }
