/* pre-push：推送前的**全链闸门**（大约 1.5 分钟）
 *
 * 只做一件事：跑 package.json 里的 `verify`（typecheck → lint → 格式 → 行数 → 单测 → 内核自检 → 构建）。
 * 不把七步抄在这里 —— 抄了就会和 package.json 漂。
 *
 * 跑完会提醒还差两件**机器代替不了**的事（真机自检 + 真机探针）。
 */
import { fail, runScript, step } from './lib.mjs'

step('推送前全链闸门（npm run verify）')

if (!runScript('verify')) {
  fail('verify 没过', '哪一步红了就修哪一步；别只修最后一步。')
  process.exit(1)
}

console.log(`
[钩子] ✓ verify 全绿

[钩子] 下面两件机器不能替你判断，推送前请自己确认：
[钩子]   1) npm run test:app        —— 内核通道自检（窗口会闪一下）
[钩子]   2) 真机探针 / 手动点一遍   —— 改 UI、会话、发送、权限时**必须**
`)
