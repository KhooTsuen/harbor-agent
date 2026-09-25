import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import Module from 'node:module'

/* ══════════════════════════════════════════════════════════════
   内核 handler 真调一遍（点了没作用的按钮）

   用户报「新建对话并指定目录」点了没反应。查下来是两个 IPC 一起死：

     handlers/workdir.cjs 里写的是 dialog.showOpenDialog(mainWindow, …)
     可 mainWindow 是 **main.cjs 的模块级变量**，这里根本没有 ——
     每次调用当场 `ReferenceError: mainWindow is not defined`，
     渲染层 chooseFolder() 把错吞了返回 {ok:false}，界面看起来就是「点了没反应」。
     （它明明已经 import 了 window-state.cjs，却一次都没用 —— 拆文件拆了一半。）

   为什么 tsc / lint / 别的测试都没拦住：
     · .cjs 不参与 tsc
     · eslint.config.js 把 `electron/**` 整个 ignore 了
     · node --check 只查语法，不查「用了没定义的变量」
   所以这一类错误**只能在跑的时候炸**。这一组就是补这个洞：

     1. 用假 electron 真加载 workdir.cjs、真调它的 handler（行为级）
     2. 扫全仓库：main.cjs 之外不许裸引用 mainWindow（静态级）
   ══════════════════════════════════════════════════════════════ */

/** 假 electron：只关心 dialog 被怎么调的、ipcMain 都注册了啥 */
function fakeEnv(dialogResult) {
  const calls = []
  const patches = []
  const handlers = new Map()
  const win = { __fakeWindow: true, isDestroyed: () => false }
  const fakeElectron = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: {
      showOpenDialog: async (parent, options) => {
        calls.push({ parent, options })
        return dialogResult
      },
    },
  }
  return { calls, patches, handlers, win, fakeElectron }
}

/**
 * 用假 electron / window-state / config 加载 workdir.cjs，拿回它注册的通道。
 *
 * config 也要打桩：真 config.patch 会写 data/config.json，自检不该碰用户数据。
 */
function loadWorkdir(dialogResult, workdir = 'C:/fake-default-workdir') {
  const env = fakeEnv(dialogResult)
  const fakeWindowState = { get: () => env.win, set: () => {} }
  const fakeConfig = {
    get: () => ({ general: { workdir } }),
    patch: (patch) => {
      env.patches.push(patch)
      return { ok: true }
    },
  }
  const fakeLog = { info: () => {}, warn: () => {}, error: () => {} }
  const originalLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return env.fakeElectron
    if (request.endsWith('window-state.cjs')) return fakeWindowState
    if (request.endsWith('core/config.cjs')) return fakeConfig
    if (request.endsWith('core/log.cjs')) return fakeLog
    return originalLoad.call(this, request, ...rest)
  }
  try {
    for (const key of Object.keys(require.cache ?? {})) {
      if (key.includes('handlers') && key.includes('workdir.cjs')) delete require.cache[key]
    }
    /* 用**仓库里的**真文件，不是测试里抄一份 */
    require(join(ROOT, 'electron/handlers/workdir.cjs'))
  } finally {
    Module._load = originalLoad
  }
  return env
}

/** 递归找出 electron 下所有 .cjs（用相对路径，报错时好定位） */
function listCjs(dir, acc = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) listCjs(rel, acc)
    else if (entry.name.endsWith('.cjs')) acc.push(rel)
  }
  return acc
}

/**
 * 安全地调一次通道：抛错也要继续往下测。
 * （第一次修这个 bug 时，异常直接把组崩在半路，后面几条断言一条都没跑到。）
 */
async function invoke(env, channel) {
  const fn = env.handlers.get(channel)
  if (typeof fn !== 'function') return { ok: false, error: `${channel} 没注册` }
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function run() {
  group('内核 handler · 目录选择（点了没作用）')

  /* ── 1. 行为级：真调一次 ── */

  const cancelled = loadWorkdir({ canceled: true, filePaths: [] })
  check('workdir:get', cancelled.handlers.has('workdir:get'))
  check('★ workdir:choose 注册了（「新建对话并指定目录」靠它）', cancelled.handlers.has('workdir:choose'))
  check('★ workdir:pick 注册了（设置里「选择工作目录」靠它）', cancelled.handlers.has('workdir:pick'))

  const choose1 = await invoke(cancelled, 'workdir:choose')
  check('★ 调 workdir:choose 不抛错', choose1.ok, `抛了：${choose1.error}`)
  check('★ 目录框挂在主窗口上（不是 undefined）', cancelled.calls[0]?.parent === cancelled.win)
  check('开的是「挑目录」不是「挑文件」', (cancelled.calls[0]?.options?.properties ?? []).includes('openDirectory'))
  check('用户取消 → 说清是取消（不是报错）', choose1.value?.ok === false && choose1.value?.canceled === true)
  check('取消时不会新建对话', choose1.value?.dir === undefined)

  const pickedDir = join(ROOT, 'scripts')
  const picked = loadWorkdir({ canceled: false, filePaths: [pickedDir] })
  const choose2 = await invoke(picked, 'workdir:choose')
  check('选中 → 返回那个目录', choose2.value?.ok === true && choose2.value?.dir === pickedDir)
  check('★ choose 不动全局工作目录（只给这一条对话挂）', picked.patches.length === 0)

  const pick = await invoke(picked, 'workdir:pick')
  check('★ pick 才改全局工作目录', pick.value?.workdir === pickedDir && picked.patches.length === 1)
  check('写的是 general.workdir 这个键', picked.patches[0]?.general?.workdir === pickedDir)

  const titles = loadWorkdir({ canceled: true, filePaths: [] })
  await invoke(titles, 'workdir:choose')
  await invoke(titles, 'workdir:pick')
  check('两个框标题不一样（说清是哪种目录）', titles.calls[0]?.options?.title !== titles.calls[1]?.options?.title)
  check('标题提示了「这个对话」', String(titles.calls[0]?.options?.title ?? '').includes('对话'))

  /* ── 2. 静态级：main.cjs 之外不许裸引用 mainWindow ── */

  const offenders = []
  for (const rel of listCjs('electron')) {
    if (rel.endsWith('main.cjs')) continue
    readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')
        if (/(?<![\w.])mainWindow(?![\w])/.test(code) && !/(let|var|const)\s+mainWindow/.test(code)) {
          offenders.push(`${rel}:${i + 1}`)
        }
      })
  }
  check(
    '★ main.cjs 之外没人裸引用 mainWindow（要窗口就 windowState.get()）',
    offenders.length === 0,
    offenders.join('、'),
  )

  const wdSrc = readFileSync(join(ROOT, 'electron/handlers/workdir.cjs'), 'utf8')
  check('★ workdir.cjs 真的用上了 windowState（不是 import 了摆着）', wdSrc.includes('windowState.get()'))
  check('没把 mainWindow 找回来', wdSrc.includes('mainWindow') === false)
}
