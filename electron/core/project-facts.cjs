/**
 * 项目事实层 —— 每轮从磁盘重算的「这个项目现在是什么样」
 *
 * ── 缺的是什么（缺口 C）──
 * 长任务里对话会被裁剪，**丢的是对话里的探索结果**：这个目录有什么、测试怎么跑、
 * 关键文件在哪个子目录。丢了之后模型只能重新侦察，而且常反复侦察同一件事
 * （真机现象：同一个目录内容在一个长任务里被问了三遍，模型每次都说「我看看」）。
 *
 * ── 为什么是「派生视图」而不是新存储 ──
 * 只要事实是**从磁盘再算一次就能得到**的，它就不怕被裁掉 —— 每轮重算，天然新鲜。
 * 所以：**不写盘、不进 memory.json、不新增 IPC、不新增配置字段**。
 * 和任务台账（`task-context.cjs`）的分工：那边是「这次要做什么」（要人立任务），
 * 这边是「磁盘上现在有什么」（任何人、任何对话都有，不用立任务）。
 *
 * ── 失效机制（过期的事实不能一直用）──
 *   ① 每轮重扫 —— 这份事实的「更新时间」就是本轮；
 *   ② 与上一轮不同就**显式标出变化**（测试入口从无到有、顶层多了目录……），
 *      免得模型拿旧印象干活；
 *   ③ 扫不动（目录没了 / 不是目录）→ 返回空串：**宁可不给，也不给过期的**；
 *   ④ git 那段另带 30 秒 TTL —— git 状态不需要秒级精度，而每轮 spawn 一个进程
 *      不值当（失败也缓存，不反复去 spawn 一个跑不起来的 git）。
 *
 * ── 挂在哪一层（实测挑的，别随手挪）──
 * 交给 `task-context.cjs` 拼进 `taskState` 层（和 `verify-hint.cjs` 同一个地方），
 * 不是挂在项目上下文那层：
 *   · 项目上下文层会被 `context-builder` 按 `budget.project` 裁剪 —— 实测在
 *     Harbor 自己这个仓库（AGENT.md 很长）里，事实层被整段挤掉了；
 *   · `taskState` 在 prompt-stack 里属于**易变区**（排在稳定区之后），
 *     所以它变来变去不会把前面那大片稳定区的前缀缓存冲掉。
 *
 * ★ 因为这个「易变区」的位置，块里**不许放每轮都变的东西** —— 时间戳、
 *   「多少秒前问的」这种都不能写（写了就每轮废掉一段缓存）。
 *   要表达「这是新鲜的」，用一句「每轮从磁盘重扫」就够。
 *
 * ── 预算 ──
 * ≤ 900 字符（`MAX_CHARS`）：每轮都进提示，写长了就是负担。只做**浅层**扫描
 * （顶层 + 最多 3 个子目录各一层），不递归 —— 递归会随项目变大而变慢。
 */

const fs = require('node:fs')
const path = require('node:path')
const summary = require('./workspace-summary.cjs')

const MAX_CHARS = 900
const MAX_ENTRIES = 14
const MAX_SUBDIRS = 3
const MAX_SUB_ENTRIES = 8
const GIT_TTL_MS = 30 * 1000
/** 值得展开看一眼的子目录（按顺序取前 MAX_SUBDIRS 个，存在才取） */
const SUBDIR_CANDIDATES = ['src', 'electron', 'scripts', 'tools', 'docs', 'test', 'tests', 'app', 'lib']

/** 上一轮的指纹（进程内，按目录分）—— 只为标出「变了什么」 */
const lastSeen = new Map()
/** git 结果的小缓存（TTL = GIT_TTL_MS），顺手记时间戳好说明「多久前问的」 */
const gitCache = new Map()

/** 只给自检用：清掉记忆（让「和上一轮相比」这类断言可重复） */
function resetMemory() {
  lastSeen.clear()
  gitCache.clear()
}

/** 是不是目录（读不动就当不是 —— 单项失败不拖垮整个扫描） */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function names(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** 顶层条目：目录带 `/`；排序后只留前 MAX_ENTRIES 个，其余只报个数 */
function topEntries(dir) {
  const all = names(dir)
    .filter((n) => n !== '.git')
    .sort()
  const list = all.slice(0, MAX_ENTRIES).map((n) => `${n}${isDir(path.join(dir, n)) ? '/' : ''}`)
  return { list, more: Math.max(0, all.length - list.length), total: all.length }
}

/** 几个常见源码目录各展开一层（只给名字，不递归） */
function subEntries(dir) {
  const out = []
  for (const name of SUBDIR_CANDIDATES) {
    if (out.length >= MAX_SUBDIRS) break
    const full = path.join(dir, name)
    if (!isDir(full)) continue
    const all = names(full)
    if (all.length === 0) continue
    const list = all.slice(0, MAX_SUB_ENTRIES)
    out.push({ name, list, more: Math.max(0, all.length - list.length) })
  }
  return out
}

/** git 摘要（带 TTL；`summary.gitSummary` 自己只读 + 超时 2.5s，失败给 ok:false） */
function gitOf(dir, now) {
  const hit = gitCache.get(dir)
  if (hit && now - hit.at < GIT_TTL_MS) return { ...hit.value, at: hit.at }
  let value = { ok: false, error: 'git 查询失败' }
  try {
    value = summary.gitSummary(dir)
  } catch (error) {
    value = { ok: false, error: String(error?.message ?? error) }
  }
  /* 失败的也缓存 —— 反复去 spawn 一个跑不起来的 git 更糟 */
  gitCache.set(dir, { at: now, value })
  return { ...value, at: now }
}

/**
 * 扫一次。**纯读**：任何一项失败都只让那一项缺失，不抛。
 *
 * @param {string} workdir
 * @returns {object | null} 目录不存在时给 null
 */
function scan(workdir) {
  const dir = String(workdir ?? '')
  if (!dir || !isDir(dir)) return null
  const now = Date.now()
  const stack = (() => {
    try {
      return summary.detectStack(dir)
    } catch {
      return []
    }
  })()
  const testCommand = (() => {
    try {
      return summary.testCommandOf(dir)
    } catch {
      return ''
    }
  })()
  return {
    ok: true,
    dir,
    name: path.basename(dir),
    stack,
    testCommand,
    top: topEntries(dir),
    subs: subEntries(dir),
    git: gitOf(dir, now),
    at: now,
  }
}

/** 拿来比「变没变」的指纹（只放会变、且变了要说的那几样） */
function fingerprintOf(facts) {
  return JSON.stringify({
    stack: facts.stack,
    test: facts.testCommand,
    top: facts.top.list,
    subs: facts.subs.map((s) => `${s.name}:${s.list.join(',')}`),
  })
}

/** 「与上一轮相比变了什么」—— 没变给空数组（不变就不说话） */
function diffLines(prev, cur) {
  if (!prev) return []
  const lines = []
  if (prev.testCommand !== cur.testCommand) {
    lines.push(`测试入口：${prev.testCommand || '（没有）'} → ${cur.testCommand || '（没有）'}`)
  }
  if (prev.stack.join('/') !== cur.stack.join('/')) {
    lines.push(`技术栈：${prev.stack.join('/') || '（没认出来）'} → ${cur.stack.join('/') || '（没认出来）'}`)
  }
  const before = new Set(prev.top.list)
  const after = new Set(cur.top.list)
  const added = cur.top.list.filter((n) => !before.has(n))
  const removed = prev.top.list.filter((n) => !after.has(n))
  if (added.length || removed.length) {
    const parts = []
    if (added.length) parts.push(`多了 ${added.slice(0, 5).join(' ')}`)
    if (removed.length) parts.push(`少了 ${removed.slice(0, 5).join(' ')}`)
    lines.push(`顶层：${parts.join('，')}`)
  }
  return lines.slice(0, 4)
}

function body(facts, changes) {
  const lines = ['## 这个项目的现状（每轮从磁盘重扫；和你的印象不一样时以它为准）']
  lines.push(`- 目录：${facts.name}`)
  if (facts.stack.length > 0) lines.push(`- 技术栈：${facts.stack.join(' / ')}`)
  lines.push(
    facts.testCommand
      ? `- 测试入口：\`${facts.testCommand}\``
      : '- 测试入口：**没有**（要验证就得先建一个能一条命令跑起来的最小用例）',
  )
  if (facts.top.list.length > 0) {
    lines.push(
      `- 顶层（${facts.top.total} 个）：${facts.top.list.join(' ')}${facts.top.more > 0 ? ` …还有 ${facts.top.more} 个` : ''}`,
    )
  }
  for (const sub of facts.subs) {
    lines.push(`- \`${sub.name}/\`：${sub.list.join(' ')}${sub.more > 0 ? ` …还有 ${sub.more} 个` : ''}`)
  }
  if (facts.git.ok) {
    lines.push(`- Git：${facts.git.branch} 分支，${facts.git.changes} 个文件未提交`)
  }
  if (changes.length > 0) lines.push(`⚠ 与上一轮相比变了：${changes.join('；')}`)
  return lines.join('\n')
}

/**
 * 生成要拼进「项目上下文」那一层的一段。**没有 workdir / 目录不在 → 空串**
 * （不注入一个空标题，也不给过期的事实）。
 *
 * @param {{ workdir?: string }} [options]
 */
function build({ workdir = '' } = {}) {
  let facts = null
  try {
    facts = scan(workdir)
  } catch {
    facts = null
  }
  if (!facts) {
    /* 目录没了：把这一轮的记忆也清掉，免得下次见面还拿老指纹比 */
    if (workdir) lastSeen.delete(String(workdir))
    return ''
  }
  const prev = lastSeen.get(facts.dir) ?? null
  const changes = diffLines(prev, facts)
  lastSeen.set(facts.dir, { stack: facts.stack, testCommand: facts.testCommand, top: facts.top })
  return body(facts, changes).slice(0, MAX_CHARS)
}

module.exports = { build, scan, resetMemory, MAX_CHARS, GIT_TTL_MS }
