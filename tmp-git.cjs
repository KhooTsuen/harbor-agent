/* 临时脚本：提交并推送 v1.14.0
   （用 execFileSync 传参；提交信息走 stdin 的 `-F -`，避开 shell 把中文/加号当路径解析） */
const { execFileSync } = require('node:child_process')

const ROOT = 'E:/CodexWorkbench'
const git = (args, input) =>
  execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', input })

git(['add', '-A'])

const message = [
  'v1.14.0：记忆可解释 + 定时任务（带授权上限）+ 网络策略变强制',
  '',
  '这三件都是「把不能兑现的话从界面上拿掉」：有两条以前写着有、其实没人执行，',
  '这次要么让它真执行，要么把话说清楚。',
  '',
  '① 记忆可解释（Memory 2.0）',
  '- core/memory-explain.cjs：打分权重唯一一份 + explain()/summarize()；',
  '  retrieve({explain:true}) 带理由，lastInjection() 给上一轮注入账',
  '- 设置→记忆：上一轮注入了什么 / 现在这批为什么会·不会被选中 / 试算提问',
  '- 自检组 71-memory-explain（43 项）',
  '',
  '② 定时任务 / 后台调度（核心是授权上限，不是调度器）',
  '- schedule-next/store/grant/run + handlers/schedules.cjs；心跳 30s，main.cjs 起',
  '- 底线：没人在场 = 没人能批准 —— confirm 恒为 false，不存在自动批准路径',
  '- 三档 readonly/workspace/full 复用已有三道闸（permission/fileScope/shellPolicy），',
  '  三档都不放开 high/critical',
  '- 界面每档说明原样取内核 detail（含「只读档连只读命令也跑不了」这种实话）',
  '- 自检组 72-schedule（73 项）',
  '',
  '③ 网络策略从声明变强制',
  '- 查出来的洞：mcp.servers[].network 与技能 network 声明都没有任何代码读过',
  '- core/net-policy.cjs + net-policy-patterns.cjs + mcp-network-guard.cjs，',
  '  在 run_shell 执行前、MCP 启动前真正执行；新配置段 security.network',
  '- 设置→权限与安全：三档模式 + 主机名单 + 内核生成的「管得到/管不到什么」',
  '- 刻意没做的两件「看起来更强」的事（写到做不到比没有更糟）：',
  '  MCP 的 network:ask 在启动阶段放行但如实标 uncontrolled；',
  '  技能 network 声明的执行点通了但没有触发入口，界面仍写「声明，不是强制」',
  '- 自检组 73-net-policy（66 项）',
  '',
  '顺手：config-defaults/normalize 拆出 config-security.cjs、config-mcp-env.cjs；',
  'preload.cjs 五处重复订阅模板收成一个 subscribe() 帮手',
  '',
  '验证：typecheck 0 · lint 0 · 601 文件 0 超行 · 单测 667（75 文件）·',
  '内核自检 2350/0 · build 通过；真机三个新面板全部命中（见 CHANGELOG）',
].join('\n')

process.stdout.write(git(['commit', '-F', '-'], message))
process.stdout.write(git(['push', 'origin', 'main']))
process.stdout.write(git(['log', '--oneline', '-3', '--decorate']))
process.stdout.write(git(['status', '-sb']).split('\n')[0] + '\n')
