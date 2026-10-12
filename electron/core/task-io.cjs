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
/* 任务台账是**用户数据**（他自己攒出来的活），写盘与损坏处理都走「别丢用户数据」的共用件 */
const { writeAtomic, keepCorruptCopy } = require('./safe-write.cjs')
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

/*
 * 单调递增的「现在」，专给 updatedAt 用。
 *
 * `Date.now()` 在同一毫秒内会撞（连续建/改任务、或一批里改好几条时），
 * 撞了之后按 updatedAt 排序就不稳定 —— `activeForSession` 会因此挑错任务，
 * 44-steering 那组在 CI 上偶发失败过。所以 updatedAt 用这个：保证进程内严格递增，
 * 排序结果确定。createdAt / finishedAt 不参与这个排序，继续用 Date.now()。
 */
let lastStamp = 0
function monotonicNow() {
  const t = Date.now()
  lastStamp = t > lastStamp ? t : lastStamp + 1
  return lastStamp
}

/*
 * 写一条任务。
 *
 * ★ 用**原子写**（`safe-write.writeAtomic`），不是 `fs.writeFileSync` —— 后者是
 *   「先截断、再写」：写到一半崩溃 / 断电 / 磁盘满，用户那条任务就只剩前半截
 *   （2026-10-13 故障注入实测：237 字节的台账在 ENOSPC 后变成 30 字节、读回 null、
 *   从任务列表里消失）。台账不用「多写一份」，用「写不完就一点都不动」。
 *
 * ★ 写失败**向调用方抛**（writeAtomic 本来就会抛）—— 不吞、不假报成功；抛了就不更新
 *   索引（索引里不能出现一条磁盘上其实没写好的任务）。
 */
function write(task) {
  fs.mkdirSync(root(), { recursive: true })
  const file = fileFor(task.id)
  writeAtomic(file, JSON.stringify(task, null, 2))
  /* 这次写成功了 → 之前的「已留档」标记作废（文件已恢复，再坏一次还应留档） */
  corruptKept.delete(file)
  syncIndex('update', task)
}

/*
 * AG-039：谁写谁更新索引（列任务时就不必再通读每个文件）。
 *
 * 用**惰性 require** 破循环：task-index 要 io（读文件），io 要 index（更新索引）。
 * 写在函数里而不是文件头，两个模块都加载完之后才真正互相引用。
 * 索引出问题不能影响写任务 —— 所以整段包在 try 里，失败只记日志。
 */
function syncIndex(action, payload) {
  try {
    const index = require('./task-index.cjs')
    if (action === 'update') index.update(payload)
    else index.remove(payload)
  } catch (error) {
    log.warn(`更新任务索引失败：${error instanceof Error ? error.message : error}`)
  }
}

/** 本进程内已经留过档的损坏文件 —— 同一个坏文件重复读只留一份，别刷一地副本 */
const corruptKept = new Set()

/**
 * 读一条。
 *
 * ★ **两种情况必须分开**（以前都返回 null，看不出区别）：
 *   · **文件不在**（ENOENT）—— 正常：这条任务还没建过 / 已被删掉。返回 null，**不报错、不留档**。
 *   · **文件在、但解不开** —— 损坏。★ 绝不静默当空：那会让接下来任意一次写盘把证据盖掉
 *     （用户那条任务就无声无息没了）。这里先 `keepCorruptCopy` 留一份档，再记一条 error。
 *     原始坏文件**不删、不覆盖**（留档是**附加**的一份，不是搬走）。
 *
 * ★ 留档**只做一次**：同一份坏文件在同一进程里反复读（比如任务列表每轮都扫），
 *   只生成一份 `.corrupt-<时间戳>`；写成功后标记作废，再坏一次仍会留档。
 *
 * ★ 另：**「已留档」不等于「已恢复」** —— 留档只是保住证据让人能人工抢救，
 *   这条任务这次仍然读不出来（返回 null）。两者是两件事，别混。
 */
function get(id) {
  const file = fileFor(id)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    /* 文件不在是正常的（还没建过这条任务），不算错；别的读失败得让人看见 */
    if (error?.code !== 'ENOENT') log.warn(`读任务失败（${id}）：${error?.message ?? error}`)
    return null
  }
  try {
    return migrate(JSON.parse(raw))
  } catch (error) {
    if (!corruptKept.has(file)) {
      corruptKept.add(file)
      const kept = keepCorruptCopy(file)
      log.error(
        `任务文件解不开（${id}）：${error?.message ?? error}` +
          (kept ? ` —— 已留档 ${path.basename(kept)}` : ' —— 留档失败'),
      )
    }
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
    return (
      fs
        .readdirSync(root())
        /* 下划线开头的是元数据（`_index.json`），不是任务 —— 别把它当任务读 */
        .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
        .map((name) => name.replace(/\.json$/, ''))
    )
  } catch (error) {
    /* 目录还不存在是正常的（还没建过任务）；别的错得让人看见 */
    if (error?.code !== 'ENOENT') log.warn(`读任务目录失败：${error?.message ?? error}`)
    return []
  }
}

function remove(id) {
  try {
    fs.rmSync(fileFor(id), { force: true })
    syncIndex('remove', id)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

module.exports = { root, fileFor, newId, write, get, ids, remove, monotonicNow }
