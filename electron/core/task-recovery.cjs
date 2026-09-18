/*
 * AG-012：重启后的恢复清单
 *
 * 文档要求：发现未完成任务 → 恢复环境检查 → **询问用户是否继续**，
 * 而且「不得直接盲目恢复执行」。
 *
 * 所以这个模块只做三件事：**找出来、检查一下、给出建议** ——
 * 它一条也不执行。真正的恢复仍然要用户点「继续」才发生
 * （那是 AG-011 的 `resumeTask` → `task-resume.openForRun`）。
 *
 * 这个「只读」的性质是刻意的：启动时自动跑任务是最危险的行为之一 ——
 * 你可能刚改过它要动的文件，或者那个任务本来就是误触发的。
 */

const log = require('./log.cjs')
const taskCore = require('./task.cjs')
const taskResume = require('./task-resume.cjs')

/**
 * 计划进度：完成几条、共几条、当前停在第几条。
 * `current` 是**下标**，-1 表示全做完了（或者压根没计划）。
 */
function progressOf(plan) {
  const list = Array.isArray(plan) ? plan : []
  const isDone = (line) => /^\s*\[[xX]\]/.test(String(line))
  const done = list.filter(isDone).length
  const current = list.findIndex((line) => !isDone(line))
  return { done, total: list.length, current }
}

/**
 * 扫一遍「还没干完」的任务，每条附上恢复前该知道的信息。
 *
 * **纯读**：不发事件、不改状态、不启动任何东西。
 */
function scan() {
  let tasks = []
  try {
    tasks = taskCore.unfinished() ?? []
  } catch (error) {
    log.warn(`恢复扫描失败：${error instanceof Error ? error.message : error}`)
    return []
  }

  return tasks
    .map((task) => {
      const env = taskResume.checkEnvironment(task.id)
      /*
       * 原样带上任务记录（界面要拿 steps / plan / planVersions 渲染时间线和计划），
       * 只**附加**三样它自己没有的：环境变了没、计划走到哪、能不能恢复。
       */
      return {
        ...task,
        envChanged: env.changed,
        progress: progressOf(task.plan),
        canResume: taskResume.canResume(task.id),
      }
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

module.exports = { scan, progressOf }
