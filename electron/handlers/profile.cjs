/**
 * 个人资料（头像 + 名字）
 *
 * 侧栏左下角那个「我」原来是**写死的装饰**（`aria-hidden` + 一个圆里一个「我」字），
 * 点了没反应、也没地方改 —— 历史遗留。这里把它的后端补上：
 *
 *   · 名字 → 配置里的 `profile.name`（跟着 config 走，备份/恢复一起带走）
 *   · 头像 → **文件** `data/avatars/avatar.<ext>`，不是塞进 config
 *     （头像是二进制、几百 KB 到几 MB，塞进 config 会让每次写配置都搬一遍它）
 *
 * 渲染层拿到的是 data URL（`sandbox: true` 下渲染层读不了本地文件，
 * 项目里选图那条路 `fs:pickImageAsDataUrl` 也是这么做的，保持一致）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('../core/paths.cjs')
const configCore = require('../core/config.cjs')
const log = require('../core/log.cjs')

/* 头像只留一份：换图就把它覆盖掉，不留历史（用户想换回来重新选一张就是） */
const STEM = 'avatar'
/* 头像不需要大图；拦一下免得选到手机拍的 8MB 原图 */
const MAX_BYTES = 4 * 1024 * 1024
const OK_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

function dir() {
  const full = DIRS.avatars
  fs.mkdirSync(full, { recursive: true })
  return full
}

/** 找现在那张头像（`avatar.*`）—— 没有就 null */
function currentFile() {
  try {
    const found = fs
      .readdirSync(dir())
      .find((name) => name.startsWith(`${STEM}.`) && !name.endsWith('.tmp'))
    return found ? path.join(dir(), found) : null
  } catch {
    return null
  }
}

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase().replace('.', '')
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'svg') return 'image/svg+xml'
  return `image/${ext || 'png'}`
}

function toDataUrl(file) {
  try {
    return `data:${mimeOf(file)};base64,${fs.readFileSync(file).toString('base64')}`
  } catch {
    return ''
  }
}

/** 删掉所有旧头像（换格式时旧的 `avatar.png` 不能留着，否则读到的是旧图） */
function clearFiles() {
  const file = currentFile()
  if (file) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* 删不掉就算了，下面写新的会覆盖同名文件 */
    }
  }
}

function name() {
  const value = configCore.get()?.profile?.name
  return typeof value === 'string' ? value : ''
}

function register({ ipcMain }) {
  /* 打开界面时读一次：名字 + 头像（data URL），头像没有就是空串 */
  ipcMain.handle('profile:get', () => {
    const file = currentFile()
    return { ok: true, name: name(), avatar: file ? toDataUrl(file) : '' }
  })

  ipcMain.handle('profile:setName', (_event, value) => {
    const next = String(value ?? '').slice(0, 40)
    configCore.patch({ profile: { name: next } })
    return { ok: true, name: next }
  })

  ipcMain.handle('profile:pickAvatar', async (event) => {
    /* electron 惰性 require：自检要在没有 Electron 的环境里测这个模块的纯逻辑 */
    const { dialog, BrowserWindow } = require('electron')
    const win = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择头像',
      filters: [{ name: '图片', extensions: OK_EXT }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }

    const from = picked.filePaths[0]
    const ext = path.extname(from).toLowerCase().replace('.', '')
    if (!OK_EXT.includes(ext)) return { ok: false, error: `不支持这种格式：.${ext}` }
    try {
      if (fs.statSync(from).size > MAX_BYTES) {
        return { ok: false, error: '图片太大了（超过 4 MB），换张小点的' }
      }
      const target = path.join(dir(), `${STEM}.${ext}`)
      /* 先写临时文件再改名：中途失败不会把现有头像弄成半张图 */
      fs.copyFileSync(from, `${target}.tmp`)
      clearFiles()
      fs.renameSync(`${target}.tmp`, target)
      return { ok: true, avatar: toDataUrl(target), name: name() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`保存头像失败：${message}`)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('profile:clearAvatar', () => {
    clearFiles()
    return { ok: true, avatar: '' }
  })
}

module.exports = { register, currentFile, MAX_BYTES, OK_EXT }
