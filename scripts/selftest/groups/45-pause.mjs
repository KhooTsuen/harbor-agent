import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-040（从 41-budget 搬来的）：**撞预算停下来那一下要发通知**

   停下来等你决定，是件值得说一声的事 —— 但它是「提醒」不是「报错」，
   而且要把「撞了哪一项、用了多少、上限多少」原样带上（界面要显示 50 / 50）。

   单独一个文件是因为 41-budget 那组顶到 300 行了；这里只关心**通知的文案与级别**，
   不需要真台账（`endNotice` 的输入本来就是一个人任务对象）。
   ══════════════════════════════════════════════════════════════ */

const taskNotify = require(join(ROOT, 'electron/core/task-notify.cjs'))

export async function run() {
  group('AG-040 / 撞预算要通知')

  const notice = taskNotify.endNotice('paused', {
    id: 'task-moved-1',
    title: '跑一个长活',
    sessionId: 'selftest-ag040-pause',
    status: 'paused',
    pauseReason: 'budget',
    changedFiles: [],
    errors: [],
    result: '',
    budgetHit: {
      reason: 'maxSteps',
      label: '轮数上限',
      used: 50,
      limit: 50,
      spentMs: 1000,
      toolCalls: 2,
    },
  })
  check('★ paused + 撞预算 → 有通知', Boolean(notice), JSON.stringify(notice))
  check('是提醒不是错误（warning）', notice?.kind === 'warning', notice?.kind)
  check(
    '通知里带上数字和两个选择',
    notice?.description.includes('50 / 50') && notice?.description.includes('继续'),
    notice?.description,
  )
  check(
    '没撞预算停下来，就不推送停下的通知',
    taskNotify.endNotice('paused', { title: 'x' }) === null,
  )
  check('完成 / 失败照旧通知', taskNotify.endNotice('completed', { title: 'x' })?.kind === 'success')
}
