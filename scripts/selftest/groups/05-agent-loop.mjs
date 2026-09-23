/**
 * 自检 / Agent 循环（冒烟）与会话目录分组 —— 这两组最重，单独一个文件
 *
 * 从 scripts/selftest.mjs 拆出来的（那边 1193 行了）。
 * 每个文件导出 `run()`，由 selftest.mjs 按顺序调用 —— 组之间**不共享状态**，
 * 所以加新组只要在 selftest.mjs 的清单里加一行。
 */

import { check, group } from '../harness.mjs'
import {
  ROOT,
  SANDBOX,
  configModule,
  disposeTasks,
  join,
  memory,
  require,
  session,
  taskCore,
  tools,
} from '../env.mjs'

/** 故意让模型挂的那一趟用的 sessionId（专用是为了兜底清理） */
const LOOP_FAIL_SESSION = 'selftest-loop-fail'

export async function run() {
  group('Agent 循环（冒烟）')
  const llmModule = require(join(ROOT, 'electron/core/llm.cjs'))
  const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
  const credentialsCore = require(join(ROOT, 'electron/core/credentials.cjs'))

  /* 造一个「有 Key 的供应商」，不去碰用户真实配置 */
  const PROBE_KEY = 'sk-selftest-loop-123456'
  credentialsCore.set('provider:selftest-loop', PROBE_KEY)
  const probeProvider = {
    id: 'selftest-loop',
    name: '自检供应商',
    baseUrl: 'https://example.invalid/v1',
    credentialRef: 'provider:selftest-loop',
    chatPath: '/chat/completions',
    models: ['probe-model'],
    enabled: true,
  }
  const loopConfig = {
    ...configModule.get(),
    /* loop 会优先用 config.activeProvider —— 传进去，否则它会去读真实配置 */
    activeProvider: probeProvider,
    providers: [probeProvider],
    assistant: { ...configModule.get().assistant, model: 'probe-model' },
    tools: { ...configModule.get().tools, permission: 'full' },
    memory: { ...configModule.get().memory, autoWrite: 'off' },
  }

  const originalChatStream = llmModule.chatStream
  let capturedOptions = null

  try {
    /* ── ① 最简单的一轮：模型直接回答，不要工具 ── */
    llmModule.chatStream = async (options) => {
      capturedOptions = options
      /*
       * 顺手触发 onUsage —— **这条是补漏来的**。
       *
       * 以前这个 stub 直接 return，从不调 onUsage，于是「用量累加」那条路径
       * 一次都没跑到：loop.cjs 里 `mergeUsage` 因为拆分漏了 import，
       * 315 项测试照样全绿，真发一句话才报 “mergeUsage is not defined”。
       */
      options.onUsage?.({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      return { content: '冒烟测试回答', reasoning: '', toolCalls: [], usage: null }
    }

    const firstRun = await loopCore.run({
      history: [{ role: 'user', content: '随便说一句' }],
      config: loopConfig,
      workdir: SANDBOX,
      mode: 'pair',
      goal: '随便说一句',
      sessionId: 'selftest',
      signal: new AbortController().signal,
      emit: () => {},
      confirm: async () => true,
    })

    check('一轮对话能跑完', firstRun.content === '冒烟测试回答', JSON.stringify(firstRun.content))
    check('真的调到了模型', capturedOptions !== null)
    check(
      '带上了解密后的 Key',
      capturedOptions?.apiKey === PROBE_KEY,
      String(capturedOptions?.apiKey),
    )
    check('模型名传对了', capturedOptions?.model === 'probe-model', String(capturedOptions?.model))
    check('系统提示里有工作目录', String(capturedOptions?.messages?.[0]?.content).includes(SANDBOX))
    check(
      '工具清单传下去了',
      Array.isArray(capturedOptions?.tools) && capturedOptions.tools.length > 0,
    )
    check(
      '建了任务记录',
      typeof firstRun.taskId === 'string' && firstRun.taskId.startsWith('task_'),
    )
    check('建了改动事务', typeof firstRun.changeSetId === 'string')

    const taskAfter = taskCore.get(firstRun.taskId)
    check('任务被标成完成', taskAfter?.status === 'completed', String(taskAfter?.status))
    taskCore.remove(firstRun.taskId)

    /* ── ② 带工具调用的一轮：模型先要工具，再给答案 ── */
    let call = 0
    llmModule.chatStream = async () => {
      call += 1
      if (call === 1) {
        return {
          content: '看看文件\n\n```plan\n1. 读 hello.txt\n2. 汇报\n```',
          reasoning: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'read_file',
              arguments: JSON.stringify({ path: 'hello.txt' }),
            },
          ],
          usage: null,
        }
      }
      return { content: '读完了', reasoning: '', toolCalls: [], usage: null }
    }

    const toolRun = await loopCore.run({
      history: [{ role: 'user', content: '读一下 hello.txt' }],
      config: loopConfig,
      workdir: SANDBOX,
      mode: 'pair',
      goal: '读一下 hello.txt',
      sessionId: 'selftest',
      signal: new AbortController().signal,
      emit: () => {},
      confirm: async () => true,
    })

    check('带工具的对话能跑完', toolRun.content === '读完了', JSON.stringify(toolRun.content))
    check('工具真的执行了', toolRun.toolRuns.length === 1, String(toolRun.toolRuns.length))
    check('工具结果是文件内容', String(toolRun.toolRuns[0]?.output).includes('line one'))
    check(
      '计划被解析进任务',
      taskCore.get(toolRun.taskId)?.plan?.length === 2,
      JSON.stringify(taskCore.get(toolRun.taskId)?.plan),
    )
    check('步骤被记进任务', taskCore.get(toolRun.taskId)?.steps?.length === 1)
    taskCore.remove(toolRun.taskId)

    /* ── ③ 模型报错时的分类与降级路径 ── */
    let attempts = 0
    llmModule.chatStream = async () => {
      attempts += 1
      const error = new Error('fetch failed')
      error.code = 'ECONNRESET'
      throw error
    }

    let failed = false
    const events = []
    try {
      await loopCore.run({
        history: [{ role: 'user', content: 'x' }],
        config: { ...loopConfig, fallback: { enabled: false, attempts: 0, retryOn: [] } },
        workdir: SANDBOX,
        mode: 'pair',
        /*
         * ★ 这一趟是**故意让模型挂**：循环里先建任务再执行，抛错之后 taskId 拿不到，
         *   任务就留在数据目录里了（2026-09-24 查出来：data/tasks 里一条空 goal 的 failed
         *   正是它）。所以给个专用 sessionId，好在 finally 里兜底清掉。
         */
        goal: '（自检）模型挂掉的那次',
        sessionId: LOOP_FAIL_SESSION,
        signal: new AbortController().signal,
        emit: (e) => events.push(e.type),
        confirm: async () => true,
      })
    } catch {
      failed = true
    }
    check('模型挂了会抛出来（交给上层报给用户）', failed)
    check('只尝试了一次（关掉重试时）', attempts === 1, String(attempts))
  } finally {
    llmModule.chatStream = originalChatStream
    credentialsCore.remove('provider:selftest-loop')
    /* 按专用 sessionId 兜底清一遍：上面那趟是抛错出来的，taskId 根本拿不到 */
    disposeTasks(taskCore.list({ sessionId: LOOP_FAIL_SESSION }).map((item) => item.id))
  }

  /* ══════════════════════════════════════════════════════
     会话的工作目录（侧栏「对话文件夹 / 单独对话」靠它分组）
     ══════════════════════════════════════════════════════ */

  group('会话 / 目录分组')
  const dirA = 'E:\probe\项目A'
  const dirB = 'E:\probe\项目B'

  const inA = session.create({ title: '挂在 A 的对话', workdir: dirA })
  const inB = session.create({ title: '挂在 B 的对话', workdir: dirB })
  const loose = session.create({ title: '单独对话', workdir: '' })

  const byId = Object.fromEntries(session.list().map((item) => [item.id, item]))
  check(
    '会话记住了自己的目录',
    byId[inA.id]?.workdir === dirA,
    JSON.stringify(byId[inA.id]?.workdir),
  )
  check(
    '空目录就是空（不会被硬塞一个默认值）',
    byId[loose.id]?.workdir === '',
    JSON.stringify(byId[loose.id]?.workdir),
  )

  const folderGroups = session.workdirs()
  check(
    'workdirs 能列出多个目录',
    folderGroups.filter((d) => d.workdir === dirA || d.workdir === dirB).length === 2,
  )
  check(
    '空目录也单独成组',
    folderGroups.some((d) => d.workdir === ''),
  )

  /* 换目录 = 侧栏里「移到文件夹 / 移出文件夹」 */
  session.updateMeta(loose.id, { workdir: dirA })
  check('能改会话的目录', session.list().find((i) => i.id === loose.id)?.workdir === dirA)
  session.updateMeta(loose.id, { workdir: '' })
  check(
    '也能摘掉目录（变成单独对话）',
    session.list().find((i) => i.id === loose.id)?.workdir === '',
  )

  session.remove(inA.id)
  session.remove(inB.id)
  session.remove(loose.id)

  /* ══════════════════════════════════════════════════════
     系统提示内容回归（CE-001 事故守卫）

     这一组是**补漏来的**：分层的 Prompt Stack 上线时漏了「环境 / 工具清单 /
     模式说明 / 做事的规矩 / 安全边界」五块，模型于是不知道今天几号、
     也没有了注入边界 —— 而且过了 tsc、lint 和全部测试。

     单测「层数对不对」拦不住这种退化，只有断言**内容在不在**才行。
     所以这里逐项钉住。**删层或改文案会让这组红，那是故意的。**
     ══════════════════════════════════════════════════════ */
}
