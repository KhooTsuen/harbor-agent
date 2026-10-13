/**
 * 计划：打卡（`mark_step_done` 工具的内核落点）
 *
 * 从 `task-plan.cjs` 拆出来的 —— 那边加完「打卡 + 指纹口径」就破了 300 行硬红线
 * （AGENT.md 硬约束 2）。按**职责**拆：`task-plan.cjs` 管「计划是什么」（解析 / 版本 /
 * 迁移 / 指纹），这里只管一件事 —— 把某一步标成完成。**没碰 `task.cjs`**（硬禁区 8）。
 *
 * ⚠️ 对 `task-plan.cjs` 一律**惰性 require**（见下面的 `core()`），避免顶层循环引用：
 *    task-plan 顶层要 require 本文件（为了 re-export `markStepDone`），若这里顶层再
 *    require 回去就成了环。惰性拿到的是**已加载好的同一份缓存**，安全。
 */

/** 惰性拿 task-plan 的纯函数（isDone / progressOf / nextActionOf / stripMarks）—— 破循环 */
function core() {
  return require('./task-plan.cjs')
}

/** 把一条计划项标成完成：`[ ] x` → `[x] x`；没带标记就前置补 `[x] `（只动标记、不动正文） */
function markLine(line) {
  const text = String(line)
  if (/^\s*\[[ xX]\]/.test(text)) return text.replace(/^(\s*)\[[ xX]\]/, '$1[x]')
  return `[x] ${text}`
}

/** 一条计划项去掉勾选标记后的正文（提示里用）—— 口径复用 task-plan 的 `stripMarks`（只一处） */
function lineText(line) {
  return String(core().stripMarks([line])[0] ?? '').trim()
}

/**
 * 打卡：把计划第 `index` 步标为完成。
 *
 * ★ 完成状态**就写在 `plan` 的字符串里**（`[x]`）—— 不新增字段、不改结构、零迁移。
 *   好处：① 严格模式的门禁（`task-strict.cjs` 数的是 `plan` 里的 `[x]`）自动覆盖它
 *         （所以「只打卡不验证」照样被拦 —— 这是不许拿打卡骗门禁的**机制保证**，不是自觉）；
 *         ② UI（PlanCard / PlanBar / TaskRow）本就在解析 `[x]`，**渲染零改动**。
 *
 * ★ **两处必须同步**：`task.plan` 与 `task.planVersions[last].plan` 是两份独立拷贝
 *   （`recordVersion` 各自 `.slice()`），而 PlanCard 读后者、PlanBar / TaskRow 读前者 ——
 *   只改一处，另一处不亮。
 *
 * ★ 只改内存对象、**不落盘**（落盘是调用方的事，走 `task-io.write` = `writeAtomic`）。
 *   越界 / 无计划**不抛异常**（抛了会炸掉模型循环），返回 `{ ok:false, message }` 让模型纠正。
 *
 * @returns {{ ok: boolean, changed: boolean, message: string, done?: number, total?: number }}
 */
function markStepDone(task, index) {
  const { isDone, progressOf, nextActionOf } = core()
  const plan = Array.isArray(task?.plan) ? task.plan : []
  if (plan.length === 0) {
    return { ok: false, changed: false, message: '这条任务还没有计划（先用 ```plan 块给一份），这次没法打卡。' }
  }
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= plan.length) {
    return {
      ok: false,
      changed: false,
      message: `step_index 超出范围：计划共 ${plan.length} 步（合法下标 0..${plan.length - 1}），收到 ${index}。请用合法下标重试。`,
    }
  }
  if (isDone(plan[i])) {
    return {
      ok: true,
      changed: false,
      message: `第 ${i + 1} 步「${lineText(plan[i])}」之前已经打过卡了，无需重复。`,
    }
  }

  const marked = markLine(plan[i])
  plan[i] = marked
  task.plan = plan
  /* 同步现行版（PlanCard 读的就是 planVersions[last].plan） */
  const versions = Array.isArray(task.planVersions) ? task.planVersions : []
  const last = versions.length > 0 ? versions[versions.length - 1] : null
  if (last && Array.isArray(last.plan) && i < last.plan.length) last.plan[i] = marked

  /* 「下一步」跟着走（重启恢复时给用户看 —— 与 setPlan 同一个口径） */
  task.nextAction = nextActionOf(plan)
  const { done, total } = progressOf(plan)
  return {
    ok: true,
    changed: true,
    done,
    total,
    message:
      `已打卡：第 ${i + 1} 步「${lineText(marked)}」标记为完成（计划进度 ${done}/${total}）。` +
      '注意：打卡只更新计划进度，**不代表跑过验证命令** —— 严格模式下记得照常跑命令验证。',
  }
}

module.exports = { markStepDone }
