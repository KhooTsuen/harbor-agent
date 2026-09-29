/**
 * 「这台机器上有什么」—— 系统提示里的机器环境清单
 *
 * 用户的诉求原话：「每次开启新对话的时候都要让 ai 知道当前环境有什么工具可以供它使用」。
 * 这件事分成两段：**工具清单**在 `tools` 层（loop-prompt.cjs 的 toolsSection），
 * **机器环境**就是这一层。
 *
 * 为什么值得单独一层：
 *   模型脑子里的默认环境是 **Linux + bash**。而这台机器是 Windows + **cmd.exe**：
 *   它张口就写 `ls -la`、`export FOO=1`、`Get-ChildItem`，报错之后再花两三轮改写法 ——
 *   每一轮都是钱和时间。把「shell 是哪个、哪些命令真装了、哪些没装」在第一轮就说清楚，
 *   这几类返工直接没了。而且这一层的内容**整个运行期间不变**，放在提示的稳定区不亏
 *   （稳定前缀命中约 1/10 价，见 prompt-stack.cjs 的说明）。
 *
 * 三条硬约束：
 *   ① **探一次就存住**。这里要 spawn 十几条进程（本机实测每条约 120ms），
 *      每轮都跑会把每一轮都拖慢；而且结果每轮一样，重算也不会变，纯浪费。
 *   ② **不许猜**。探不到就当没有，明说「没装」；探测**还没跑完**时对工具一律不表态
 *      （`describe(null)` 只给静态那段）—— 「乱说没装」比「不知道」更坏：
 *      模型会去装一个本来有的东西，或者干脆放弃一条能走通的路。
 *   ③ `warm()` 在启动时跑（`main.cjs`，不阻塞窗口），用户发第一条消息时基本已经好了。
 *      **没有同步探测这条路** —— 同步跑 1 秒多，卡在第一条消息上，不划算。
 *      代价如实写在下面 `describe()` 的注释里。
 */

const { exec, execFile } = require('node:child_process')
const log = require('./log.cjs')

/*
 * 探测清单。顺序 = 常用程度，故意短：每条都是一次进程 spawn，
 * 而且清单越长模型越不看。加之前先想清楚「模型真的会用它吗」。
 */
const CANDIDATES = [
  { name: 'node', arg: '-v' },
  { name: 'npm', arg: '-v' },
  { name: 'git', arg: '--version' },
  { name: 'python', arg: '--version' },
  { name: 'uv', arg: '--version' },
  { name: 'docker', arg: '--version' },
  { name: 'rg', arg: '--version' },
  { name: 'curl', arg: '--version' },
]

const TIMEOUT_MS = 5000
/* 版本串截断长度：`curl 8.13.0 (Windows) libcurl/…` 那种一行能到 100+ 字符，没用 */
const MAX_VERSION = 44

let cache = null
let warming = null

/** 形状：`{ at, found: [{ name, path, version }] }`；path 为空 = 这台机器上没有 */
function emptyEntry(name) {
  return { name, path: '', version: '' }
}

/**
 * 命令在不在 PATH 里（在就给出**第一个**路径）。
 *
 * 先查存在、再问版本，两步是为了 `python`：Windows 上它可能是个
 * 「微软商店别名」——直接执行会把商店窗口弹到用户脸上。查都查不到就绝不执行。
 */
function locate(name) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  return new Promise((resolve) => {
    execFile(
      finder,
      [name],
      { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve('')
        const first = String(stdout ?? '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
        resolve(first ?? '')
      },
    )
  })
}

/** 把 `git version 2.55.0.windows.3` 收拾成 `2.55.0.windows.3` */
function tidyVersion(name, raw) {
  const first =
    String(raw ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  /* name 都是写死在 CANDIDATES 里的字母，但正则拼串还是转义一下，免得以后加了带点的名字 */
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return first.replace(new RegExp(`^${escaped}\\s+(version\\s+)?`, 'i'), '').slice(0, MAX_VERSION)
}

/** 问版本：只对**已经查到的**命令调（path 非空） */
function versionOf(pathStr, arg) {
  return new Promise((resolve) => {
    exec(
      `"${pathStr}" ${arg} 2>&1`,
      { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => resolve(String(stdout ?? stderr ?? '').trim()),
    )
  })
}

/** 真探一轮（全部并发；串行会慢成 10 倍） */
async function probe() {
  const found = await Promise.all(
    CANDIDATES.map(async (candidate) => {
      const where = await locate(candidate.name)
      if (!where) return emptyEntry(candidate.name)
      const raw = await versionOf(where, candidate.arg)
      return { name: candidate.name, path: where, version: tidyVersion(candidate.name, raw) }
    }),
  )
  return { at: Date.now(), found }
}

/**
 * 静态那段：**不用探测**（平台就是答案），但回报最高。
 *
 * `run_shell` 用的是 Node 的 `exec` —— Windows 上它走 `cmd.exe`，不是 PowerShell。
 * 这条不写清楚，模型十次有八次会按 bash 写。
 */
function staticLines() {
  if (process.platform === 'win32') {
    return [
      '## 这台机器上有什么',
      '- `run_shell` 执行命令走的是 **cmd.exe**（不是 PowerShell，也不是 bash）：',
      '  用 `dir` / `type` / `copy` / `del` / `findstr` / `where` 这类命令；多条用 `&&` 连；',
      '  路径分隔符是 `\\`（`E:\\proj\\a.txt`），路径里有空格就整体加双引号。',
      '  **不要**写 `ls -la`、`export X=1`、`Get-ChildItem`、`$(...)` —— 在 cmd 里都会失败。',
      '  在目录里搜文本用 `findstr /s /n /i "关键词" *.*`；`grep` / `rg` 不一定有（见下面）。',
    ]
  }
  return [
    '## 这台机器上有什么',
    '- `run_shell` 执行命令走的是 **/bin/sh**：管道、`&&`、`$(...)` 都能用，',
    '  但 `source`、数组、`[[ ]]` 这类 bash 专有写法不要用。',
  ]
}

/**
 * 渲染成给模型看的那几行。
 *
 * @param {{ found: Array }|null} data  探测结果；`null` = 还没探到
 *
 * `data` 为 `null`（启动后头一两秒内发第一条消息才会碰上）时**只输出静态段**。
 * 这时候前缀比后面短一截，那一轮会丢掉一次缓存命中 —— 如实认下：
 * 乱说「没装」会让模型做出错误的决定，丢一次缓存只是多花几分钱。
 */
function describe(data) {
  const lines = staticLines()
  if (!data || !Array.isArray(data.found)) return lines.join('\n')

  const installed = data.found.filter((item) => item.path)
  const missing = data.found.filter((item) => !item.path).map((item) => item.name)

  if (installed.length > 0) {
    lines.push('- 这台机器**已经装好**的命令行工具（直接用，不用先试装一遍）：')
    for (const item of installed) {
      lines.push(`  - ${item.name}${item.version ? ` ${item.version}` : '（版本没读到）'}`)
    }
  }
  if (missing.length > 0) {
    lines.push(
      `- PATH 里**没有**：${missing.join('、')} —— 需要它们时先跟用户说清楚，` +
        '不要假装有，也不要自己偷偷装（装东西要用户点头）。',
    )
  }
  if (installed.length === 0 && missing.length === 0) {
    lines.push('- 没探测到任何命令行工具。')
  }
  return lines.join('\n')
}

/** 同步取这一层的内容（没探到就是静态段，见 describe 的注释） */
function section() {
  return describe(cache)
}

/** 启动时预热一次。重复调是空转（不会重复 spawn） */
async function warm() {
  if (cache) return cache
  if (warming) return warming
  warming = probe()
  try {
    cache = await warming
    const names = cache.found.filter((item) => item.path).map((item) => item.name)
    log.info(`机器环境探测完成：${names.join('、') || '（什么都没找到）'}`)
  } catch (error) {
    log.warn(`机器环境探测失败（不影响对话）：${error instanceof Error ? error.message : error}`)
  } finally {
    warming = null
  }
  return cache
}

/** 测试用：清掉缓存，让下一次 section() 回到「还没探到」 */
function reset() {
  cache = null
  warming = null
}

module.exports = { section, warm, reset, describe, probe, tidyVersion, CANDIDATES, MAX_VERSION }
