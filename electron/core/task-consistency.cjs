/**
 * 同一件事跑第二遍时的「一致性检查」（②-3）
 *
 * ── 要回答的问题 ──
 * 「这个结果能信吗？」同一件事跑两遍，如果结论、测试结果、改动范围差很多，
 * 说明它**不稳定** —— 用户不该拿上一次的经验去预期下一次。
 *
 * ── 什么算「同一件事」──
 * 同一个会话里，目标**足够像**的历史任务。用记忆那边同一套 2-gram Jaccard
 * （`memory-similarity.cjs`）—— 不要求一字不差，人不会把同一句话打两遍。
 * 只跟**比它早**的任务比：拿后来的当参照没有意义。
 *
 * ── 为什么放在「诊断」里，而不是自动弹提示 ──
 * 「差异大」不等于「有问题」：第二次本来就可能是做得更细、或者发现了新东西。
 * 自动弹等于替用户下判断，而且弹错一次他就再也不看了。
 * 放在诊断里 —— 他主动问「这条任务怎么回事」时，把**两份事实并排摆出来**。
 *
 * ── 一条规矩（和诊断一致）──
 * 只写台账里读得到的事实，不推测。哪一项读不出来就不提哪一项。
 */

const { similarity } = require('./memory-similarity.cjs')
const taskOutcome = require('./task-outcome.cjs')

/** 目标像到什么程度才算「同一件事」。低于这个值宁可不说 */
const SIMILAR_ENOUGH = 0.45

const STATUS_TEXT = {
  running: '还在跑',
  waiting_user: '在等你确认',
  paused: '停住了',
  completed: '做完了',
  failed: '失败了',
  cancelled: '被放弃了',
}

const TEST_TEXT = {
  none: '没跑测试',
  passed: '测试通过',
  failed: '测试没过',
  unknown: '测试结果读不出来',
}

/** 只留文件名 —— 报告是给人扫的。台账里存的是 `{ path, at }` 这种对象，得先取出来 */
function short(file) {
  const path = file && typeof file === 'object' ? file.path : file
  return String(path ?? '')
    .split(/[\\/]/)
    .filter(Boolean)
    .slice(-2)
    .join('/')
}

function listOfSet(set, limit = 3) {
  const all = [...set]
  const head = all.slice(0, limit).join('、')
  return all.length > limit ? `${head} 等 ${all.length} 个` : head || '（一个都没有）'
}

/** 「多久之前」—— 报告里说的是「上次」，得让人对得上时间 */
function whenAgo(at) {
  const stamp = Number(at ?? 0)
  /* 没记时间（老任务 / 字段缺失）就说不了 —— 别把 1970 年算成「两万天前」 */
  if (!Number.isFinite(stamp) || stamp <= 0) return ''
  const diff = Date.now() - stamp
  if (diff <= 0) return ''
  const mins = Math.round(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}

/**
 * 从一堆任务里找「和这条最像、而且比它早」的那条。
 *
 * @param {Array} tasks 同一会话（或同一批）里的任务
 * @param {object} task 当前这条
 * @returns {{ task: object, score: number } | null}
 */
function findPrior(tasks, task, { threshold = SIMILAR_ENOUGH } = {}) {
  const mine = String(task?.goal ?? '')
  if (!task || !mine.trim()) return null
  const at = Number(task.createdAt ?? 0)
  let best = null
  for (const other of tasks ?? []) {
    if (!other || other.id === task.id) continue
    if (Number(other.createdAt ?? 0) >= at) continue
    const score = similarity(mine, String(other.goal ?? ''))
    if (score < threshold) continue
    if (!best || score > best.score) best = { task: other, score }
  }
  return best
}

/**
 * 两次跑同一件事，差在哪。
 *
 * @returns {{ notes: string[], divergent: boolean, score: number }}
 *   `divergent` = 至少有一项对不上（**不是**「有问题」的意思）
 */
function compare(prior, current, score = 0) {
  const notes = []
  const a = taskOutcome.outcomeOf(prior)
  const b = taskOutcome.outcomeOf(current)

  const statusA = STATUS_TEXT[prior?.status] ?? prior?.status
  const statusB = STATUS_TEXT[current?.status] ?? current?.status
  if (statusA !== statusB) notes.push(`结论不一样：上次${statusA}，这次${statusB}`)

  /* 两边都没跑过测试时不必说 —— 「都没跑」不是差异 */
  if (a.tests !== b.tests && a.tests !== 'none' && b.tests !== 'none') {
    notes.push(`测试结果不一样：上次${TEST_TEXT[a.tests] ?? a.tests}，这次${TEST_TEXT[b.tests] ?? b.tests}`)
  }

  const filesA = new Set((prior?.changedFiles ?? []).map(short))
  const filesB = new Set((current?.changedFiles ?? []).map(short))
  if (filesA.size + filesB.size > 0 && filesA.size !== filesB.size) {
    notes.push(
      `改动范围不一样：上次 ${filesA.size} 个文件（${listOfSet(filesA)}），这次 ${filesB.size} 个（${listOfSet(filesB)}）`,
    )
  } else if (filesA.size > 0) {
    /* 数量一样但动的不是同一批 —— 那才是「做的事不一样」 */
    const same = [...filesA].every((file) => filesB.has(file))
    if (!same) notes.push(`动的不是同一批文件：上次 ${listOfSet(filesA)}，这次 ${listOfSet(filesB)}`)
  }

  const planA = (prior?.plan ?? []).length
  const planB = (current?.plan ?? []).length
  if (planA > 0 && planB > 0 && Math.abs(planA - planB) >= 3) {
    notes.push(`计划的步数差得多：上次 ${planA} 步，这次 ${planB} 步`)
  }

  return { notes, divergent: notes.length > 0, score }
}

module.exports = { findPrior, compare, whenAgo, SIMILAR_ENOUGH, STATUS_TEXT, TEST_TEXT }
