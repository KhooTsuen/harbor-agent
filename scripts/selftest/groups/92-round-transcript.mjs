import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   逐轮累积（时间线第二步）

   内核以前只把**最后一轮**的正文与思考回给渲染层，于是这些都只剩最后一段：
   复制整条回答 / 导出 / 搜索 / **下一轮喂回模型的历史**。
   中间那些轮说了什么，只有界面上的时间线（`rounds`）记得 —— 它只活在渲染进程里。

   提前结束那几条路（暂停 / 撞预算 / 轮数到顶）以前更狠：正文被那句提示**整个换掉**。

   累积器是纯函数（`loop-transcript.cjs`），所以这里跑的是**真断言**，
   不是扫源码；另外再钉两条接线（它有没有被真的调用）。
   ══════════════════════════════════════════════════════════════ */

const { createTranscript } = require(join(ROOT, 'electron/core/loop-transcript.cjs'))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/**
 * 累积器对外就一对回调（`stream()` 返回的正是 `callModel` 要的那两个）。
 * 测试也走它 —— 顺便验「累积的同时真的把事件发出去了」。
 */
function feeder(t) {
  const events = []
  const stream = t.stream((e) => events.push(e))
  return { events, say: (text) => stream.content(text), think: (text) => stream.reasoning(text) }
}

export async function run() {
  group('逐轮累积 / 一轮之内')
  const one = createTranscript()
  const oneFeed = feeder(one)
  oneFeed.say('第一段')
  oneFeed.think('想了 1')
  check('只有一轮时就是它自己', one.soFar().content === '第一段')
  check('间隔都是空行（Markdown 才分段）', one.soFar().content.indexOf('\n\n') === -1)
  check(
    '★ 累积的同时真的发事件（边攒边推给渲染层）',
    oneFeed.events.length === 2 &&
      oneFeed.events[0].type === 'content' &&
      oneFeed.events[1].type === 'reasoning',
  )

  group('逐轮累积 / 多轮接起来')
  const multi = createTranscript()
  const multiFeed = feeder(multi)
  multiFeed.say('第一段')
  multiFeed.think('想了 1')
  multi.mergeRound()
  multiFeed.say('第二段')
  const joined = multi.soFar()
  check(
    '★ 两轮的正文都在（以前只回最后一轮）',
    joined.content === '第一段\n\n第二段',
    JSON.stringify(joined.content),
  )
  check('★ 思考也逐轮累积', joined.reasoning === '想了 1')
  check('合并之后当前轮清空（下一轮从零攒）', multi.soFar().content === '第一段\n\n第二段')

  group('逐轮累积 / 最后一轮的终稿')
  const tail = createTranscript()
  feeder(tail).say('原稿')
  check('★ 传终稿就用终稿（自检复核会改写最后一轮）', tail.soFar('复核后的稿').content === '复核后的稿')
  check('传空 → 退回这一轮攒的原文（别把最后一轮弄丢）', tail.soFar('').content === '原稿')

  group('逐轮累积 / 提前结束')
  const stopped = createTranscript()
  const stoppedFeed = feeder(stopped)
  stoppedFeed.say('做了一半')
  stopped.mergeRound()
  stoppedFeed.say('又写了一点')
  const notice = stopped.withNotice('（任务已暂停，可以从这里继续）')
  check(
    '★ 提示接在后面 —— 正文没被换掉（以前只剩那句提示）',
    notice.content.startsWith('做了一半') && notice.content.endsWith('（任务已暂停，可以从这里继续）'),
    notice.content,
  )
  check('这一轮写的东西也在', notice.content.includes('又写了一点'))
  check('不留空段（三个换行）', !notice.content.includes('\n\n\n'))

  group('逐轮累积 / 接线')
  const loopSrc = read('electron/core/loop.cjs')
  check('★ 每一轮结束都并进总账', loopSrc.includes('transcript.mergeRound()'))
  check('★ 正常收尾回的是**全量**，不是最后一轮', loopSrc.includes('...transcript.soFar(finalContent)'))
  check(
    '★ 四条提前结束的路都带上了（暂停 / 撞预算 / 转圈交人 / 轮数到顶）',
    loopSrc.includes('pausedResult({ turn, usage: totalUsage, toolRuns, transcript })') &&
      loopSrc.includes('budgetHit: hit, transcript })') &&
      loopSrc.includes('loopHit, transcript })') &&
      loopSrc.includes('maxTurns: MAX_TURNS, transcript })'),
  )
  check(
    '★ 提示不再把正文换掉（换成接在上面）',
    read('electron/core/loop-result.cjs').includes('transcript?.withNotice('),
  )
}
