/**
 * 文件系统 IPC
 *
 * 给右栏的「文件」标签用：列目录、读文件、看文件信息。
 *
 * 为什么不直接复用 core/tools/list_dir.cjs：那些工具是给模型用的，返回的是
 * 拼好的文本（带着给模型看的说明）。界面要的是结构化的树，形状不一样。
 * 但**路径解析和黑名单是同源的** —— 都从 _shared.cjs 拿，免得两处规则跑偏。
 *
 * 安全边界：只能读工作目录里的东西（除非用户显式改了工作目录）。
 * 这是个本地工具，不做沙箱，但至少不把整块磁盘随随便便摊开。
 */

const fs = require('node:fs')
const path = require('node:path')
const config = require('../core/config.cjs')
const log = require('../core/log.cjs')
const { TEXT_EXT, isTextFile } = require('./fs-text-ext.cjs')

/** 列目录时最多爬这么深，太深了界面也没法看 */
const MAX_DEPTH = 6
/** 单层最多列这么多条目，node_modules 那种目录会撑爆界面 */
const MAX_ENTRIES = 500
/** 超过这个大小就不读进来预览了（4 MB） */
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024

/** 这些目录不进文件树 —— 列出来只会让人找不到东西 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  'coverage',
  '.turbo',
])

function workdir() {
  const configured = config.get().general.workdir
  if (configured && fs.existsSync(configured)) return configured
  const { DIRS } = require('../core/paths.cjs')
  fs.mkdirSync(DIRS.workspace, { recursive: true })
  return DIRS.workspace
}

/** 把用户给的相对路径解析到工作目录下，并挡掉往上级跑 */
function resolveInside(input) {
  const root = workdir()
  const raw = String(input ?? '').trim()
  if (!raw) return root

  const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw)
  const rel = path.relative(root, absolute)

  /* rel 以 .. 开头说明跑到工作目录外面了 */
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`只能访问工作目录里的内容。工作目录是：${root}`)
  }
  return absolute
}

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    /* 权限不够之类的就返回空，不要让整个树挂掉 */
    log.warn(`列目录失败 ${dir}：${error instanceof Error ? error.message : error}`)
    return []
  }
}

/**
 * 递归建树。
 *
 * 返回给界面的节点形状：
 *   { name, path（相对工作目录）, type: 'file' | 'dir', size, children?: [] }
 */
function buildTree(dir, depth, counter) {
  if (depth > MAX_DEPTH) return []

  const entries = readdirSafe(dir)
  const dirs = []
  const files = []

  for (const entry of entries) {
    if (counter.count >= MAX_ENTRIES) break
    if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.gitignore') continue

    const full = path.join(dir, entry.name)
    const rel = path.relative(workdir(), full)

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      counter.count += 1
      dirs.push({
        name: entry.name,
        path: rel,
        type: 'dir',
        children: buildTree(full, depth + 1, counter),
      })
    } else if (entry.isFile()) {
      counter.count += 1
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        /* 读不到大小就 0 */
      }
      files.push({ name: entry.name, path: rel, type: 'file', size })
    }
  }

  /* 目录在前，同类按名字排 —— 和资源管理器习惯一致 */
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN')
  return [...dirs.sort(byName), ...files.sort(byName)]
}

/** 目录直接子的名字，用于文件名的 @ 补全 */
function listNames(dirInput) {
  const dir = resolveInside(dirInput)
  return readdirSafe(dir)
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
    .slice(0, MAX_ENTRIES)
}

function readTextFile(fileInput) {
  const file = resolveInside(fileInput)

  const stat = fs.statSync(file)
  if (stat.isDirectory()) throw new Error('这是个目录，不是文件')
  if (stat.size > MAX_PREVIEW_BYTES) {
    throw new Error(`文件太大（${(stat.size / 1024 / 1024).toFixed(1)} MB），不预览了`)
  }

  const buffer = fs.readFileSync(file)
  /* 含大量 0 字节的当二进制处理 */
  if (buffer.includes(0)) {
    return { binary: true, size: stat.size, path: path.relative(workdir(), file) }
  }

  return {
    binary: false,
    text: buffer.toString('utf8'),
    size: stat.size,
    path: path.relative(workdir(), file),
    ext: path.extname(file).toLowerCase().replace('.', ''),
  }
}

function register({ ipcMain }) {
  ipcMain.handle('fs:workdir', () => {
    const dir = workdir()
    return { workdir: dir, exists: fs.existsSync(dir) }
  })

  /**
   * 整棵树（界面打开「文件」标签时调一次）。
   *
   * 可以指定目录 —— 侧栏里每条对话有自己的工作目录，右栏文件树得跟着它走，
   * 不能永远显示全局那个。目录不存在/没给就回落到默认工作目录。
   */
  ipcMain.handle('fs:tree', (_event, requested) => {
    const asked = typeof requested === 'string' ? requested : ''
    const root = asked && fs.existsSync(asked) ? asked : workdir()
    try {
      fs.mkdirSync(root, { recursive: true })
      const counter = { count: 0 }
      const children = buildTree(root, 0, counter)
      return {
        ok: true,
        root,
        name: path.basename(root) || root,
        children,
        truncated: counter.count >= MAX_ENTRIES,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), root }
    }
  })

  ipcMain.handle('fs:list', (_event, dir) => {
    try {
      return { ok: true, items: listNames(dir) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('fs:read', (_event, file) => {
    try {
      return { ok: true, ...readTextFile(file) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** 在系统资源管理器里定位文件 */
  ipcMain.handle('fs:reveal', async (_event, target) => {
    try {
      const { shell } = require('electron')
      const full = resolveInside(target)
      if (!fs.existsSync(full)) return { ok: false, error: '找不到这个文件' }
      shell.showItemInFolder(full)
      return { ok: true, path: full }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** 选一张图片，读成 data URL（OCR 要的是 base64，普通文本读法不够用） */
  ipcMain.handle('fs:pickImageAsDataUrl', async (event) => {
    const { dialog, BrowserWindow } = require('electron')
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }

    const file = result.filePaths[0]
    try {
      const stat = fs.statSync(file)
      /* base64 会膨胀 ~33%，10MB 的图传过去就 13MB 了，拦一下 */
      if (stat.size > 10 * 1024 * 1024) {
        return {
          ok: false,
          error: `图片太大（${(stat.size / 1024 / 1024).toFixed(1)} MB），换张小点的`,
        }
      }
      const ext = path.extname(file).toLowerCase().replace('.', '')
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
      return { ok: true, dataUrl, name: path.basename(file) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** 附件：弹文件选择框，把选中文件的文本读回来。不限工作目录（用户显式选的） */
  ipcMain.handle('fs:pickAndRead', async (event) => {
    const { dialog, BrowserWindow } = require('electron')
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择要附加的文件',
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }

    const file = result.filePaths[0]
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_PREVIEW_BYTES) {
        return {
          ok: false,
          error: `文件太大（${(stat.size / 1024 / 1024).toFixed(1)} MB），附加不进来`,
        }
      }
      const buffer = fs.readFileSync(file)
      if (buffer.includes(0)) {
        return { ok: false, error: '这是二进制文件，附加不进来' }
      }
      return {
        ok: true,
        name: path.basename(file),
        path: file,
        text: buffer.toString('utf8'),
        size: stat.size,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

module.exports = { register, workdir, resolveInside, isTextFile, MAX_PREVIEW_BYTES }
