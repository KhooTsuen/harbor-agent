/**
 * 自检 / 写盘原子性：rename 撞上「文件被占着」要重试，不是一撞就崩
 *
 * 来由（2026-10-05）：`safe-write.cjs` 的 rename 在 Windows 上撞上 EPERM
 * （`rename 'data/memory.json.tmp-968' -> 'data/memory.json'`），一抛就把整个自检崩掉、
 * **连着拦下三次推送**。而那两条写用户数据的路（记忆 / 会话）用的是同一个函数 ——
 * 所以这不是「自检不稳」，是一次普通的写盘会变成崩溃。
 *
 * 怎么造这个错：`safe-write.cjs` 里是 `require('node:fs')`，与这里拿到的是**同一个
 * 模块对象**，把 `fs.renameSync` 换掉就能精确模拟「前 N 次被占着」。
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const { writeAtomic } = require(join(ROOT, 'electron/core/safe-write.cjs'))

/**
 * 让 renameSync 按给定的 code 序列失败：第 i 次调用若 `codes[i-1]` 有值就抛那个 code，
 * 否则走真的 rename。返回 `{ result, calls }`，结束时一定恢复原函数。
 */
function withRenameFailures(codes, fn) {
  const real = fs.renameSync
  let calls = 0
  fs.renameSync = (from, to) => {
    calls += 1
    const code = codes[calls - 1]
    if (code) {
      const error = new Error(`${code}：假装目标文件被别的东西占着`)
      error.code = code
      throw error
    }
    return real(from, to)
  }
  try {
    return { result: fn(), calls }
  } finally {
    fs.renameSync = real
  }
}

export async function run() {
  group('写盘：rename 被占着要重试')

  const dir = fs.mkdtempSync(join(tmpdir(), 'harbor-safe-write-'))
  const file = join(dir, 'memory.json')
  const read = () => fs.readFileSync(file, 'utf8')

  writeAtomic(file, '{"a":1}')
  check('正常写：内容落盘', read() === '{"a":1}', read())

  /* ★ 事故现场：前两次 EPERM、第三次成功 —— 修之前第二次就崩了 */
  const twice = withRenameFailures(['EPERM', 'EPERM'], () => writeAtomic(file, '{"a":2}'))
  check('★ 前两次被占着 → 重试到成功', read() === '{"a":2}', read())
  check('★ 确实重试了（rename 被调 3 次）', twice.calls === 3, `实际 ${twice.calls} 次`)

  withRenameFailures(['EBUSY'], () => writeAtomic(file, '{"a":3}'))
  check('EBUSY 是同一类，同样重试', read() === '{"a":3}', read())

  /* 一直占着：必须抛出来，不能假装写成功，也不能无限重试 */
  const always = withRenameFailures(Array(20).fill('EPERM'), () => {
    try {
      writeAtomic(file, '{"a":4}')
      return '没抛'
    } catch (error) {
      return error.code
    }
  })
  check('★ 一直写不进去 → 抛错（不糊弄成成功）', always.result === 'EPERM', String(always.result))
  check('★ 重试有上限，不是死循环', always.calls === 5, `实际 ${always.calls} 次`)
  check('失败时留下的是旧内容，不是半截', read() === '{"a":3}', read())

  /* 非「被占着」的错误立刻抛 —— 磁盘满了重试一百次也没用 */
  const fatal = withRenameFailures(['ENOSPC'], () => {
    try {
      writeAtomic(file, '{"a":5}')
      return '没抛'
    } catch (error) {
      return error.code
    }
  })
  check('★ ENOSPC 这类真错误一次都不重试', fatal.calls === 1 && fatal.result === 'ENOSPC', `调了 ${fatal.calls} 次`)

  /* 失败后不留垃圾：data/ 里曾经攒下过 .tmp-* 残留 */
  const left = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))
  check('★ 失败后不留 .tmp-* 临时文件', left.length === 0, left.join('、') || '（干净）')

  /* ── 只允许一处实现（2026-10-07 收敛）─────────────────────────
   * 以前 session-crypto / projects / schedule-store 各揣一份自己的原子写，而且都没有
   * 退避重试 —— 同一个「别丢数据」的东西散在四处，改一处漏三处。现在只有 safe-write。
   * 这条钉住「不许再冒出第二份实现」。 */
  const definitions = []
  for (const file of walkCjs(join(ROOT, 'electron'))) {
    const text = fs.readFileSync(file, 'utf8')
    if (/function\s+writeAtomic\s*\(/.test(text)) definitions.push(file.replace(ROOT, '').replace(/\\/g, '/'))
  }
  check(
    '★ 全内核只有一个 writeAtomic 实现',
    definitions.length === 1 && definitions[0].endsWith('electron/core/safe-write.cjs'),
    `找到 ${definitions.length} 处：${definitions.join('、') || '（没有）'}`,
  )

  fs.rmSync(dir, { recursive: true, force: true })

  await configSaveSection()
}

/*
 * 配置保存：**先落盘、成功了才换内存**（2026-10-31 修）。
 *
 * 修之前 `save()` 是「cache = merged 然后 writeFile」：写盘一抛，内存里已经是新值、
 * 磁盘上还是旧值 —— 界面显示改成功了，重启却变回去；更糟的是下一次保存别的字段
 * 会把这批脏值顺带写进磁盘。隔离数据实测（theme 内存 light / 磁盘 default）。
 *
 * ★ 全部放**子进程**里跑，三个理由：
 *   ① 失败要造在 config.json 上，不能碰自检自己的配置（同进程 mock 会波及别组）；
 *   ② 「重启读回」必须是**真重启**（新进程、cache 为 null），不是清 require 缓存 ——
 *      后者会在一个进程里造出两份配置模块实例，正是硬约束 #9 说的那种事故；
 *   ③ 子进程的数据根用 `HARBOR_UNIT_TEST_DATA_DIR` 指定（paths.cjs 只允许它落在
 *      `data/harbor-test/runs` 下），跑完整个目录删掉。
 */
const RUNS = join(ROOT, 'data', 'harbor-test', 'runs')

/** 子进程脚本：按 CFG_MODE 走四步中的一步；失败注入分 mock（写入口抛 EPERM）与 real（只读位）两种 */
const CHILD = `
const fs = require('node:fs')
const path = require('node:path')
const ROOT = process.env.CFG_ROOT
const config = require(path.join(ROOT, 'electron/core/config.cjs'))
const target = path.resolve(require(path.join(ROOT, 'electron/core/paths.cjs')).configFile())
const mode = process.env.CFG_MODE
const out = (o) => process.stdout.write(JSON.stringify(o))
const readGeneral = () => JSON.parse(fs.readFileSync(target, 'utf8')).general
const NEW = { theme: 'light', fontScale: 130 }
const OLD = { theme: 'spec', fontScale: 110 }
if (mode === 'setup') {
  config.patch({ general: OLD })
  out({ done: true })
} else if (mode === 'ok') {
  let err = ''
  try { config.patch({ general: NEW }) } catch (e) { err = String(e.code || e.message) }
  out({ err, disk: readGeneral(), mem: config.get().general })
} else if (mode === 'read') {
  out({ disk: readGeneral(), mem: config.get().general })
} else if (mode === 'fail') {
  const before = fs.readFileSync(target)
  const rw = fs.writeFileSync
  const rr = fs.renameSync
  const real = process.env.CFG_FAIL === 'real'
  let hits = 0
  /* ★ 「真写不进去」的造法必须分平台（2026-11-02 修，CI ubuntu 上红的就是这条）：
       · Windows：把目标文件设成只读 —— rename 盖上去会被挡成 EPERM。这是当年事故的原样。
       · POSIX：目标文件只读**挡不住** rename（rename 只要求目录可写），
         所以改设**所在目录**只读 —— 写临时文件那一步就 EACCES。
       只 chmod 文件的话，Linux 上写入会成功，后面几条断言就跟着空转。 */
  const chmodTarget = process.platform === 'win32' ? target : path.dirname(target)
  const restoreMode = real ? fs.statSync(chmodTarget).mode & 0o777 : 0
  if (real) fs.chmodSync(chmodTarget, process.platform === 'win32' ? 0o444 : 0o555)
  else {
    const boom = () => { hits += 1; const e = new Error('EPERM：假装配置写不进去'); e.code = 'EPERM'; throw e }
    fs.writeFileSync = (t, ...rest) => (path.resolve(String(t)) === target ? boom() : rw(t, ...rest))
    fs.renameSync = (f, t) => (path.resolve(String(t)) === target ? boom() : rr(f, t))
  }
  let err = ''
  try { config.patch({ general: NEW }) } catch (e) { err = String(e.code || e.message) }
  finally {
    fs.writeFileSync = rw
    fs.renameSync = rr
    if (real) fs.chmodSync(chmodTarget, restoreMode)
  }
  const after = fs.readFileSync(target)
  out({ err, hits, bytesSame: before.equals(after), disk: JSON.parse(after.toString('utf8')).general, mem: config.get().general })
}
`

/** 起一个子进程跑上面那一步，返回它吐的 JSON（吐不出来就带上 stderr 便于定位） */
function childStep(dir, mode, fail = '') {
  const res = spawnSync(process.execPath, ['-e', CHILD], {
    cwd: ROOT,
    timeout: 30_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      CFG_ROOT: ROOT,
      CFG_MODE: mode,
      CFG_FAIL: fail,
      HARBOR_UNIT_TEST: '1',
      HARBOR_UNIT_TEST_DATA_DIR: dir,
    },
  })
  try {
    return JSON.parse(res.stdout)
  } catch {
    return { parseError: true, status: res.status, stdout: res.stdout, stderr: res.stderr }
  }
}

async function configSaveSection() {
  group('写盘：配置保存失败时，内存不许领先于磁盘')

  const dir = join(RUNS, `config-save-selftest-${Date.now()}`)
  try {
    const setup = childStep(dir, 'setup')
    check(
      '基线：先把 theme=spec/fontScale=110 存进磁盘',
      setup.done === true,
      JSON.stringify(setup).slice(0, 200),
    )

    const failMock = childStep(dir, 'fail', 'mock')
    check(
      '★ 保存失败必须抛出去（不许糊弄成成功）',
      String(failMock.err ?? '').startsWith('EPERM'),
      JSON.stringify(failMock.err ?? failMock).slice(0, 200),
    )
    check(
      '★ 失败后**内存还是旧值**（修之前这里是 light/130：内存抢先改了，磁盘没动）',
      failMock.mem?.theme === 'spec' && failMock.mem?.fontScale === 110,
      `theme=${failMock.mem?.theme} fontScale=${failMock.mem?.fontScale}`,
    )
    check(
      '★ 失败后磁盘字节一字未变（旧文件完好）',
      failMock.bytesSame === true && failMock.disk?.theme === 'spec',
      `bytesSame=${failMock.bytesSame} disk.theme=${failMock.disk?.theme}`,
    )
    check(
      '★ 失败真的造出来了（注入没生效的话上面几条是空转）',
      failMock.hits > 0,
      `写入口被拦 ${failMock.hits ?? 0} 次`,
    )

    /* 真重启：新进程从磁盘读回来，必须与失败后内存里的值一致 */
    const readBack = childStep(dir, 'read')
    check(
      '★ 重启读回 = 失败后的生效值（内存没有领先磁盘）',
      readBack.mem?.theme === failMock.mem?.theme &&
        readBack.mem?.fontScale === failMock.mem?.fontScale &&
        readBack.disk?.theme === 'spec',
      `重启=${readBack.mem?.theme}/${readBack.mem?.fontScale} 失败后内存=${failMock.mem?.theme}/${failMock.mem?.fontScale}`,
    )

    /* 不用 mock，让写盘**真的**失败（Windows 只读文件 / POSIX 只读目录）—— 判据不依赖「我拦对了地方」 */
    const failReal = childStep(dir, 'fail', 'real')
    check(
      '★ 真实写不进去：同样抛错、字节不变、内存不变',
      /^E(PERM|ACCES)$/.test(String(failReal.err ?? '')) &&
        failReal.bytesSame === true &&
        failReal.mem?.theme === 'spec' &&
        failReal.mem?.fontScale === 110,
      `err=${failReal.err} bytesSame=${failReal.bytesSame} mem=${failReal.mem?.theme}/${failReal.mem?.fontScale}`,
    )

    /* 正对照：不造失败，正常保存必须成功，且磁盘/内存/重启三处一致（防空转） */
    const ok = childStep(dir, 'ok')
    check(
      '★ 正对照：正常保存成功，磁盘与内存同时变成新值',
      ok.err === '' && ok.disk?.theme === 'light' && ok.mem?.theme === 'light' && ok.mem?.fontScale === 130,
      `err=${ok.err} disk=${ok.disk?.theme}/${ok.disk?.fontScale} mem=${ok.mem?.theme}/${ok.mem?.fontScale}`,
    )
    const okRead = childStep(dir, 'read')
    check(
      '★ 正对照：重启读到新值（保存是真落了盘，不是只改了内存）',
      okRead.disk?.theme === 'light' && okRead.mem?.fontScale === 130,
      JSON.stringify(okRead.mem),
    )

    /* 源码钉子：往后再有人把 writeFile 写回 fs.writeFileSync，或把 cache 赋值挪回前面，这里当场红 */
    const configSrc = fs.readFileSync(join(ROOT, 'electron/core/config.cjs'), 'utf8')
    check(
      '★ 配置落盘走原子写（不许退回 writeFileSync 的「先截断再写」）',
      /writeAtomic\(configFile\(\)/.test(configSrc) &&
        !/fs\.writeFileSync\(configFile\(\)/.test(configSrc),
    )
    check(
      '★ save() 里「先落盘、再换缓存」的顺序没被改回去',
      configSrc.indexOf('writeFile(merged)') > 0 &&
        configSrc.indexOf('writeFile(merged)') < configSrc.indexOf('cache = merged'),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 递归收集目录下的 .cjs（自己写一个，别为一条自检引依赖） */
function walkCjs(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkCjs(full))
    else if (entry.name.endsWith('.cjs')) out.push(full)
  }
  return out
}
