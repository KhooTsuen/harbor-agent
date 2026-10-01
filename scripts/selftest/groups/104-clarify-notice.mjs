import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-053 批③/批④：澄清卡超时之后 —— **通知说什么** + **谁的注入**

   从 `102-clarify-unattended.mjs` 分出来的（那边加完「累计离场静音」到 311 行，
   硬约束 #2 是 300）。分口子选得清楚一点：102 管**巡查器本身怎么走**
   （定时任务不弹卡、到点只推一次、累计静音拦得住），这里管**两件接线**：

     · 通知文案（用户回来看的那一句：哪条任务 + 替他定了什么）
     · 依赖注入（`main.cjs` 给的是 Electron 的 powerMonitor，内核不自己 require）
   ══════════════════════════════════════════════════════════════ */

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** 剥掉注释行再扫（注释里写的示例代码不算代码） */
const codeOf = (src) =>
  src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join('\n')

const good = (patch = {}) => ({
  question: '用哪个包管理器？',
  options: [
    { label: 'pnpm', effect: '仓库里有 pnpm-lock.yaml，换 npm 会多装 1 份依赖' },
    { label: 'npm', effect: '要重新生成 lock 文件，多花约 30 秒' },
  ],
  defaultValue: 'pnpm',
  ...patch,
})

export async function run() {
  const clarify = require(join(ROOT, 'electron/core/clarify.cjs'))
  const notice = require(join(ROOT, 'electron/core/clarify-notice.cjs'))

  group('AG-053 / 超时通知：哪条任务 + 替他定了什么')
  const text = notice.timeoutNotice({
    taskTitle: '把 README 的安装步骤改成一行脚本',
    questions: clarify.normalize([
      good(),
      good({
        question: '要加 Node 版本检查吗？',
        options: [
          { label: '加', effect: '多 6 行 shell，版本不对时提前报错' },
          { label: '不加', effect: '少 6 行，Node 太老时报错信息会很含糊' },
        ],
        defaultValue: '加',
      }),
    ]).questions,
  })
  check(
    '★ 标题里有任务名（通知只有一行时用户先看「哪条」）',
    text.title.includes('把 README 的安装步骤改成一行脚本'),
    text.title,
  )
  check('★ 正文里说清了采纳的默认选项', /pnpm/.test(text.body) && /加/.test(text.body), text.body.slice(0, 80))
  check('标题是人话，不是「clarify timeout」这种内部词', /澄清超时/.test(text.title) && !/clarify|timeout/i.test(text.title))
  check(
    '拿不到任务名时不空着（不能出现「澄清超时： 已按默认继续」那种断句）',
    notice.timeoutNotice({ taskTitle: '' }).title.includes('这条任务'),
    notice.timeoutNotice({ taskTitle: '' }).title,
  )
  check('超长任务名会截断（通知塞不下）', notice.timeoutNotice({ taskTitle: 'x'.repeat(200) }).title.length <= 120)
  check('问题一条都没有时也不崩', notice.timeoutNotice({ taskTitle: 't' }).body.includes('没有可用选项'))

  group('AG-053 / 注入：main.cjs 给的是 Electron 的 powerMonitor')
  const mainSrc = read('electron/main.cjs')
  check('★ main.cjs 从 electron 里取 powerMonitor', /require\('electron'\)/.test(mainSrc) && /powerMonitor/.test(mainSrc))
  check(
    '★ 取出来是**传给 register-handlers** 的（不是自己拿来用）',
    /registerHandlers\(\{[\s\S]*?powerMonitor,[\s\S]*?\}\)/.test(mainSrc),
  )
  check('内核侧不自己 require electron（巡查器靠注入）', !codeOf(read('electron/handlers/clarify-watch.cjs')).includes("require('electron')"))
  check('离场状态机也不 require electron', !codeOf(read('electron/core/clarify-timeout.cjs')).includes("require('electron')"))
  check('通知文案模块不 require electron', !codeOf(read('electron/core/clarify-notice.cjs')).includes("require('electron')"))
  const regSrc = read('electron/register-handlers.cjs')
  check(
    '★ register-handlers 真的用它起了巡查（注入进来却不用 = 超时永远不发生）',
    regSrc.includes('clarify-watch.cjs') && regSrc.includes('powerMonitor'),
  )
  check(
    '★ 顺手把通知也接上了（起得来但从不通知 = 用户回来一脸懵）',
    regSrc.includes('timeoutNotice') && regSrc.includes('notify('),
  )
  check('★ 巡查是**每跳现读配置**（设置里改完不用重启）', read('electron/handlers/clarify-watch.cjs').includes('readLimits'))
}
