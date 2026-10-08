/**
 * 冒烟场景清单
 *
 * 每条场景 = `{ id, title, upstream, prompt, run(driver) }`：
 *   · `upstream` 决定假上游模式（对应 `tools/fake-upstream.mjs` 的路径后缀）；
 *   · `run` 只管**判据** —— 用 driver 的 UI 原语操作、用 `record()` 记一条结论。
 *
 * 每条都对着「测试全绿 ≠ 能用」的**真实事故**，不是凭空想的用例：
 *   ① `config.hasKey is not a function` —— 发消息直接发不出去；
 *   ② 拆函数留空占位 —— 流式内容**全不更新**；
 *   ③ 确认卡链路（「答完卡不消失 / 任务不继续」）。
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { APPROVE, CONFIRM_CARD } from './kit.mjs'

/** 允许后 `run_shell` 的产物落点：便携版默认工作目录是 `data/chat`（老装机可能是 `workspace`） */
const outputs = (dataDir) => [
  join(dataDir, 'chat', 'smoke-shell-ok.txt'),
  join(dataDir, 'workspace', 'smoke-shell-ok.txt'),
]

export const SCENARIOS = [
  {
    id: 'send',
    title: '发送 + 流式（事故 ①②）',
    upstream: 'ok',
    prompt: '冒烟：请回复一句话',
    async run(d) {
      await d.newConversation()
      const { typed, sent } = await d.sendPrompt(d.prompt)
      d.record('输入框可写', typed === d.prompt.length, `实际写入 ${typed}/${d.prompt.length} 字`)
      d.record('发送按钮可点', sent === true, sent === true ? '已点到 /发送消息/' : '没找到发送按钮')

      const answer = await d.waitAssistant(30000)
      d.record(
        '发送没炸（没有 hasKey 类报错）',
        Boolean(answer),
        answer ? '拿到了助手回答' : '30 秒没等到回答 —— 发送路径可能断了',
      )
      d.record(
        '流式内容非空',
        /假上游回答/.test(answer),
        answer ? `回答="${answer.slice(0, 50)}"` : '（没有回答）',
      )
    },
  },
  {
    id: 'confirm',
    title: '权限确认卡（事故 ③）',
    upstream: 'confirm',
    prompt: '冒烟：请跑一条命令',
    async run(d) {
      /*
       * 假上游先给一次 medium 的 `run_shell` 调用 → 默认 `shellPolicy.medium='ask'`
       * 应当让界面弹出「等待确认」卡；点「允许本次」后工具才执行、产物才出现。
       * 卡没弹、或点了允许产物没出，都说明确认卡链路断了。
       */
      await d.newConversation()
      const candidates = outputs(d.dataDir)
      /* 先清掉上次的残留 —— 否则「产物已存在」会让判据**不等工具执行**就假绿 */
      for (const p of candidates) rmSync(p, { force: true })

      const { typed, sent } = await d.sendPrompt(d.prompt)
      d.record('输入框可写', typed === d.prompt.length, `实际写入 ${typed}/${d.prompt.length} 字`)
      d.record('发送按钮可点', sent === true, sent === true ? '已点到 /发送消息/' : '没找到发送按钮')

      const cardUp = await d.waitFor(() => d.ev(CONFIRM_CARD, '等确认卡'), { timeoutMs: 20000 })
      d.record('权限确认卡弹出', Boolean(cardUp), cardUp ? '出现「等待确认」' : '20 秒没等到确认卡')
      if (!cardUp) return

      const approved = await d.ev(APPROVE, '点允许')
      d.record(
        '点得到「允许本次」',
        approved === true,
        approved === true ? '已点到允许按钮' : '没找到允许按钮',
      )

      const out = await d.waitFor(
        () => candidates.find((p) => existsSync(p)) || '',
        { timeoutMs: 15000, intervalMs: 500 },
      )
      d.record(
        '允许后工具真的执行了',
        Boolean(out),
        out ? `产物出现：${out}` : `15 秒没出现产物（找过 ${candidates.join('、')}）`,
      )
    },
  },
]
