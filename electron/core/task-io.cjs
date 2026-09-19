/**
 * 任务台账的读写底座（AG-035 拆分）
 *
 * `task.cjs` 拆出来的第一层：**放哪、怎么序列化**。它不认识业务 ——
 * 不知道什么是计划、什么是检查点，只负责「一个任务一个 JSON 文件」。
 *
 * 拆法照 `session-io.cjs` 的先例（那次也是主文件贴顶）：
 *   底座谁都能 require，自己谁也不 require（只有 paths / log / 迁移函数），
 *   所以不会出现循环引用 —— 这是拆文件时最容易踩的坑。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const { migrate } = require('./task-plan.cjs')
const log = require('./log.cjs')

function root() {
  return path.join(DIRS.data, 'tasks')
}

function fileFor(id) {
  return path.join(root(), `${id}.json`)
}

function newId() {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function write(task) {
  fs.mkdirSync(root(), { recursive: true })
  fs.writeFileSync(fileFor(task.id), JSON.stringify(task, null, 2), 'utf8')
}

/**
 * 读一条；文件不在 / 内容坏了 → 返回 null（任务中心不能因为一个坏文件白屏）。
 *
 * ★ 但**不许静默**：不是「文件没了」的错（比如代码里写错了变量名）一律记日志。
 *   这一条是被一次事故逼出来的 —— 拆文件时 `list()` 里残留的 `fs` 引用了
 *   模块里已经不存在的 fs，ReferenceError 被空 catch 吞掉，列表永远是空的，
 *   界面上什么都看不出来（只有自检里 20 条断言在报警）。
 */
function get(id) {
  try {
    return migrate(JSON.parse(fs.readFileSync(fileFor(id), 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') log.warn(`读任务失败（${id}）：${error?.message ?? error}`)
    return null
  }
}

/**
 * 全部任务的 id（读不到就空数组，不抛）。
 *
 * ★ 这个函数是被一次事故逼出来的：`task.cjs` 拆走 fs 之后，`list()` 里
 * 还在用 `fs.readdirSync`，而它外面套着 `catch { return [] }` ——
 * ReferenceError 被**静默吞掉**，列表永远空，界面上却什么都不报。
 * 所以这里收口：碰文件系统的事只在 io 里做。
 */
function ids() {
  try {
    return fs
      .readdirSync(root())
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''))
  } catch (error) {
    /* 目录还不存在是正常的（还没建过任务）；别的错得让人看见 */
    if (error?.code !== 'ENOENT') log.warn(`读任务目录失败：${error?.message ?? error}`)
    return []
  }
}

function remove(id) {
  try {
    fs.rmSync(fileFor(id), { force: true })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

module.exports = { root, fileFor, newId, write, get, ids, remove }
