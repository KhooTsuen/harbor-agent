import fs from 'node:fs'
import { join, ROOT, require } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   子代理 v0（只读侦察兵）

   这一组钉住四件**容易静默错**的事（都过 tsc / lint / 别的组）：

     · **只读是硬拦** —— 子代理调不动写工具（靠 tools/index.cjs 的两道闸，
       不是靠提示词）；台账里那一步得是 ok:false
     · **事件 key 隔离** —— 子代理跑完，**父任务**的状态机不许被带成 completed
       （沿用父的 traceId 就会，见 subagent.cjs 文件头坑①）
     · **深度最多 1 层** —— 子代理不能再派子代理
     · **预算切分** —— 父不限时子代理有自己的硬上限；父更小时取更小的

   前两条是**反向锁**：定义「不能发生什么」，比正向更值钱。
   ══════════════════════════════════════════════════════════════ */

const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))
const subagent = require(join(ROOT, 'electron/core/subagent.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const life = require(join(ROOT, 'electron/core/lifecycle.cjs'))
const llm = require(join(ROOT, 'electron/core/llm.cjs'))
const credentials = require(join(ROOT, 'electron/core/credentials.cjs'))
const { SANDBOX, configModule } = require(join(ROOT, 'scripts/selftest/env.mjs'))

/** 造一份能跑 runLoop 的自检配置（provider + key 都指着假地址，请求被桩拦下） */
function probeConfig(provider) {
  const base = configModule.get()
  return {
    ...base,
    activeProvider: provider,
    providers: [provider],
    assistant: { ...base.assistant, model: 'probe-model' },
    tools: { ...base.tools, permission: 'full' },
    memory: { ...base.memory, autoWrite: 'off' },
  }
}

export async function run() {
  const created = []
  const CRED = 'provider:selftest-subagent'
  const provider = {
    id: 'selftest-subagent',
    name: '自检供应商',
    baseUrl: 'https://example.invalid/v1',
    credentialRef: CRED,
    chatPath: '/chat/completions',
    models: ['probe-model'],
    enabled: true,
  }
  const config = probeConfig(provider)
  const originalChatStream = llm.chatStream

  try {
    /* ── ① 注册与形状 ─────────────────────────────────── */
    group('子代理 v0 / 注册与形状')
    const tool = registry.byName('spawn_subagent')
    check('spawn_subagent 已注册', !!tool, tool ? tool.name : '没找到')
    check('★ 不算写工具（只读权限下也能侦察）', registry.WRITE_TOOLS.has('spawn_subagent') === false)
    check(
      'task 是必填参数',
      Array.isArray(tool?.parameters?.required) && tool.parameters.required.includes('task'),
    )
    check('描述里说清了「只读」（模型据此决定用不用它）', /只读/.test(String(tool?.description)))

    /* ── ② 预算切分 ─────────────────────────────────── */
    group('子代理 v0 / 预算切分')
    check('★ 父不限 → 子代理有自己的轮数硬上限', subagent.splitForChild({ maxSteps: 0 }).maxSteps === 8)
    check(
      '★ 父有更小上限 → 取更小的（不许花得比父允许的多）',
      subagent.splitForChild({ maxSteps: 3 }).maxSteps === 3,
    )
    check('父上限更大 → 仍收在子代理的保险丝上', subagent.splitForChild({ maxSteps: 100 }).maxSteps === 8)
    check('token 不单独设（0 = 不限，v0 靠轮数兜底）', subagent.splitForChild({ maxSteps: 0 }).maxTokens === 0)

    /* ── ③ 深度最多 1 层 ─────────────────────────────── */
    group('子代理 v0 / 深度最多 1 层')
    const parentTask = taskCore.create({ goal: '父任务', sessionId: 'selftest-subagent' })
    created.push(parentTask.id)
    check('老任务读出来有 parentTaskId（迁移补的，不是 undefined）', taskCore.get(parentTask.id).parentTaskId === '')

    const nested = taskCore.create({
      goal: '已经是子代理',
      sessionId: 'selftest-subagent',
      parentTaskId: parentTask.id,
    })
    created.push(nested.id)
    check('子任务记下了 parentTaskId', taskCore.get(nested.id).parentTaskId === parentTask.id)

    const blocked = await subagent.spawn({
      task: '再派一个',
      ctx: { taskId: nested.id, workdir: SANDBOX },
      config,
    })
    check('★ 子代理不能再派子代理', blocked.ok === false && /深度/.test(String(blocked.error)), blocked.error)

    /* ── ④ 真跑：只读子代理读一份文件、带结论回来 ─────── */
    group('子代理 v0 / 真跑一遍（只读侦察）')
    fs.writeFileSync(join(SANDBOX, 'subagent-probe.txt'), 'SENTINEL-OK\n', 'utf8')
    credentials.set(CRED, 'sk-selftest-subagent-123456')

    let calls = 0
    llm.chatStream = async () => {
      calls += 1
      if (calls === 1) {
        return {
          content: '',
          reasoning: '',
          toolCalls: [
            { id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'subagent-probe.txt' }) },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      }
      return {
        content: '侦察结论：探针文件里写着 SENTINEL-OK',
        reasoning: '',
        toolCalls: [],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }
    }

    const parentPhaseBefore = life.forTask(parentTask.id).phase
    const readRun = await subagent.spawn({
      task: '读一下 subagent-probe.txt，告诉我里面写着什么',
      ctx: { taskId: parentTask.id, workdir: SANDBOX, sessionId: 'selftest-subagent' },
      config,
    })
    if (readRun.taskId) created.push(readRun.taskId)

    check('子代理跑成了', readRun.ok === true, readRun.error)
    check('结论带回来了', String(readRun.content).includes('SENTINEL-OK'), readRun.content)
    check('★ 子代理有自己的台账（parentTaskId 指回父任务）', taskCore.get(readRun.taskId)?.parentTaskId === parentTask.id)
    check('子任务收尾成 completed', taskCore.get(readRun.taskId)?.status === 'completed')
    check(
      '★ 子代理跑完，**父任务**状态机没被带成 completed',
      life.forTask(parentTask.id).phase === parentPhaseBefore,
      `父相位 ${life.forTask(parentTask.id).phase}`,
    )
    check('父任务台账里仍是 running（没被子代理收尾）', taskCore.get(parentTask.id)?.status !== 'completed')

    /* ── ④b 子代理 v1：内部每一步转给界面（卡片的数据源）──── */
    group('子代理 v1 / 每一步转给界面')
    const forwarded = []
    calls = 0
    llm.chatStream = async () => {
      calls += 1
      if (calls === 1) {
        return {
          content: '',
          reasoning: '',
          toolCalls: [
            { id: 'v1', name: 'read_file', arguments: JSON.stringify({ path: 'subagent-probe.txt' }) },
          ],
          usage: null,
        }
      }
      return { content: '看完了', reasoning: '', toolCalls: [], usage: null }
    }

    const seen = await subagent.spawn({
      task: '读一下 subagent-probe.txt',
      /* subagentEmit 平时代 tool-run-ctx.cjs 注入（这里手工给，等价） */
      ctx: {
        taskId: parentTask.id,
        workdir: SANDBOX,
        sessionId: 'selftest-subagent',
        subagentEmit: (payload) => forwarded.push(payload),
      },
      config,
    })
    if (seen.taskId) created.push(seen.taskId)

    const kinds = forwarded.map((e) => e.kind)
    check(
      '★ 起止都有边界事件（一个工具没调时界面也知道它开过、结束了）',
      kinds[0] === 'start' && kinds[kinds.length - 1] === 'done',
      JSON.stringify(kinds),
    )
    const stepEvents = forwarded.filter((e) => e.kind === 'step')
    check('★ 每一步都转出来了', stepEvents.length >= 1, `只收到 ${stepEvents.length} 条`)
    check(
      'step 里带着工具名与状态（界面照它画那一行）',
      stepEvents.some((e) => e.step?.tool === 'read_file' && e.step?.phase === 'started'),
      JSON.stringify(stepEvents[0]?.step ?? null),
    )
    check('done 带收尾状态', forwarded.some((e) => e.kind === 'done' && e.status === 'completed'))
    check(
      '每条都带 subagentTaskId（界面归位 + 想深看去台账时用）',
      forwarded.every((e) => e.subagentTaskId === seen.taskId),
    )
    /*
     * ★ 反向锁：转出去的**只有「读了哪个文件」**，没有原文 ——
     *   子代理存在的全部意义就是那些原文不进父侧（`SubagentStep` 里也只有 tool + args）。
     */
    check(
      '★ 转出去的东西里没有文件原文（隔离没破）',
      !JSON.stringify(forwarded).includes('SENTINEL-OK'),
      JSON.stringify(forwarded).slice(0, 160),
    )

    /* 没注入时（自检 / 无界面）退化成 v0：只攒不发，但不许炸 */
    calls = 0
    const noUi = await subagent.spawn({
      task: '读一下 subagent-probe.txt',
      ctx: { taskId: parentTask.id, workdir: SANDBOX, sessionId: 'selftest-subagent' },
      config,
    })
    if (noUi.taskId) created.push(noUi.taskId)
    check('★ 没人接（没注入 subagentEmit）也照常跑完', noUi.ok === true, noUi.error)

    /* ── ⑤ 反向锁：子代理写不动文件 ─────────────────── */
    group('子代理 v0 / 只读是硬拦（写工具调不动）')
    const target = join(SANDBOX, 'subagent-should-not-write.txt')
    try {
      fs.rmSync(target, { force: true })
    } catch {
      /* 本来就没有 */
    }
    calls = 0
    llm.chatStream = async () => {
      calls += 1
      if (calls === 1) {
        return {
          content: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'w1',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'subagent-should-not-write.txt', content: 'SHOULD NOT LAND' }),
            },
          ],
          usage: null,
        }
      }
      return { content: '我试过写了', reasoning: '', toolCalls: [], usage: null }
    }

    const writeRun = await subagent.spawn({
      task: '帮我在工作目录写一个文件，内容是 SHOULD NOT LAND',
      ctx: { taskId: parentTask.id, workdir: SANDBOX, sessionId: 'selftest-subagent' },
      config,
    })
    if (writeRun.taskId) created.push(writeRun.taskId)

    check('★ 写操作真的没落盘', fs.existsSync(target) === false)
    const writeStep = (taskCore.get(writeRun.taskId)?.steps ?? []).find((s) => s.tool === 'write_file')
    check(
      '★ 台账里记着这次写被拒（只读闸生效，不是模型自觉）',
      writeStep && writeStep.ok === false,
      JSON.stringify(writeStep?.ok),
    )
  } finally {
    llm.chatStream = originalChatStream
    credentials.remove(CRED)
    try {
      fs.rmSync(join(SANDBOX, 'subagent-probe.txt'), { force: true })
      fs.rmSync(join(SANDBOX, 'subagent-should-not-write.txt'), { force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  }

  /* 清理测试任务 */
  for (const id of created) taskCore.remove(id)
  check('测试任务已清理', created.every((id) => taskCore.get(id) === null))
}
