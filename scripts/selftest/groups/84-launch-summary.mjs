import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Module from 'node:module'
import { basename } from 'node:path'
import { join, mkdirSync, rmSync, ROOT, SANDBOX, writeFileSync, require } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   开屏「工作区总览」：内核扫描（core/workspace-summary.cjs）

   设计文档 §11/§17 的硬要求：
     · 全部来自真实数据（技术栈 = 真读了标志文件；git = 真问了 git）
     · 失败可分辨（每一项各自 ok —— 单项失败不拖垮整个开屏）
     · 快且不递归（浅层识别；这里顺带钉「坏 JSON 不抛」）

   夹具用 SANDBOX 里的真实目录 + 真实文件；git 一项问本仓库。
   ══════════════════════════════════════════════════════════════ */

const summary = require(join(ROOT, 'electron/core/workspace-summary.cjs'))

function fixture(name) {
  const dir = join(SANDBOX, `launch-${name}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

export async function run() {
  group('开屏总览 / 目录不存在要说清楚')
  const missing = summary.scanWorkspace(join(SANDBOX, 'launch-no-such-dir'))
  check(
    'ok:false 且带原因（不是抛异常）',
    missing.ok === false && String(missing.error).includes('不存在'),
  )
  check('空字符串也算不存在', summary.scanWorkspace('').ok === false)

  group('开屏总览 / 空目录与夹具目录')
  /*
   * 「不是 Git 仓库」的夹具必须放**系统临时目录**：
   * 自检沙箱在仓库内部，git 会把它当仓库子树（本地实测踩到）。
   */
  const empty = mkdtempSync(join(tmpdir(), 'harbor-launch-'))
  const s1 = summary.scanWorkspace(empty)
  check('空目录 → ok:true（页面照常可开）', s1.ok === true)
  check('空目录：技术栈为空、无测试入口', s1.stack.length === 0 && s1.testCommand === '')
  check('不是 Git 仓库 → git.ok:false（单项降级，不是异常）', s1.git.ok === false)
  check('名字 = 目录名', s1.name === basename(empty))
  rmSync(empty, { recursive: true, force: true })

  group('开屏总览 / 技术栈认得出来（真读文件）')
  const app = fixture('app')
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({
      name: 'x',
      scripts: { test: 'vitest run' },
      devDependencies: {
        electron: '1',
        react: '1',
        vite: '1',
        typescript: '1',
        tailwindcss: '1',
      },
    }),
  )
  writeFileSync(join(app, 'tsconfig.json'), '{}')
  const s2 = summary.scanWorkspace(app)
  const want = ['Electron', 'React', 'Vite', 'TypeScript', 'Tailwind']
  check(
    `五个标签都在（${s2.stack.join(' / ')}）`,
    want.every((label) => s2.stack.includes(label)),
  )
  check('有 scripts.test → 给出 npm test', s2.testCommand === 'npm test')

  group('开屏总览 / 坏数据不炸')
  const broken = fixture('broken')
  writeFileSync(join(broken, 'package.json'), '{oops not json')
  const s3 = summary.scanWorkspace(broken)
  check('坏 JSON 不抛：ok:true', s3.ok === true)
  check(
    '栈降级为 Node（认出「有 package.json」这一点事实）',
    s3.stack.length === 1 && s3.stack[0] === 'Node',
  )
  check('读不出 scripts → 不给测试入口', s3.testCommand === '')

  group('开屏总览 / 多语言标志与测试入口优先级')
  const multi = fixture('multi')
  writeFileSync(join(multi, 'Cargo.toml'), '[package]\nname = "x"\n')
  writeFileSync(join(multi, 'go.mod'), 'module x\n')
  const s4 = summary.scanWorkspace(multi)
  check('Rust 与 Go 都认出来', s4.stack.includes('Rust') && s4.stack.includes('Go'))
  check('cargo test 优先给（先撞上的标志先回答）', s4.testCommand === 'cargo test')

  group('开屏总览 / 真仓库的 git 摘要')
  const repo = summary.scanWorkspace(ROOT)
  check('本仓库是 Git 仓库：ok:true', repo.git.ok === true)
  check('分支是可读字符串', typeof repo.git.branch === 'string' && repo.git.branch.length > 0)
  check('变更数是数字且 ≥0', typeof repo.git.changes === 'number' && repo.git.changes >= 0)
  check('整包 ok:true 且技术栈非空（这是本仓库自身）', repo.ok === true && repo.stack.length > 0)

  /*
   * ── 第二半：新 handler 真加载、真调一次（假 electron） ──
   *
   * 这组断言抄的是 80-handlers 的教训：.cjs 不参与 tsc，
   * 「require 了没定义的东西」/「模块加载时把自己注册丢了」
   * 只能在真加载的时候爆 —— 所以别只看清单，真走一遍。
   */
  group('开屏总览 / workspace.cjs 真注册、真可调（假 electron）')
  const registered = new Map()
  const fakeElectron = { ipcMain: { handle: (name, fn) => registered.set(name, fn) } }
  const originalLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron
    return originalLoad.call(this, request, ...rest)
  }
  try {
    for (const key of Object.keys(require.cache ?? {})) {
      if (
        key.includes('handlers') &&
        (key.includes('workspace.cjs') || key.includes('workdir.cjs'))
      ) {
        delete require.cache[key]
      }
    }
    require(join(ROOT, 'electron/handlers/workspace.cjs'))
  } finally {
    Module._load = originalLoad
  }
  check('workspace:scan 注册了', typeof registered.get('workspace:scan') === 'function')
  check('task:testStatus 注册了', typeof registered.get('task:testStatus') === 'function')

  const called = registered.get('workspace:scan')(null, app)
  check(
    '★ 真调 workspace:scan：ok:true 且技术栈非空',
    called.ok === true && Array.isArray(called.stack) && called.stack.length > 0,
    JSON.stringify(called).slice(0, 200),
  )
  const ts = registered.get('task:testStatus')(null, { workdir: '' })
  check(
    '真调 task:testStatus：形状对（只读台账，不触任务）',
    ts.ok === true && ['none', 'passed', 'failed', 'unknown'].includes(ts.tests),
    JSON.stringify(ts).slice(0, 200),
  )
  /* 清掉假 electron 版的缓存，别影响后面的组（这组最后跑，但规矩得立住） */
  for (const key of Object.keys(require.cache ?? {})) {
    if (
      key.includes('handlers') &&
      (key.includes('workspace.cjs') || key.includes('workdir.cjs'))
    ) {
      delete require.cache[key]
    }
  }
}
