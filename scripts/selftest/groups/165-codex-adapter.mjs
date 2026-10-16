/**
 * 自检 / Codex CLI 后端（M-Codex，2026-10-17）
 *
 * 九块：
 *   ① 契约同形（适配器导出与 `llm.chatStream` 同名同形；分流全项目只有一处）
 *   ② JSONL 分块（半行 / 多行 / \r\n / 坏行 / 超长行 / 结尾无换行）
 *   ③ 事件归约（agent_message → content · usage → OpenAI 字段 · error 不抛）
 *   ④ prompt 拍平（system 在前 · 最后一条 user 当请求 · **如实声明没有工具**）
 *   ⑤ 进程层（参数全是常量 · 沙箱固定只读 · launcher 解析 · 杀树按 pid 不按映像名）
 *   ⑥ 取消与超时（**真跑 runCodex + 注入假 spawn** —— 不真起 codex、不真杀进程）
 *   ⑦ 配置向后兼容（旧配置无 kind → openai）+ 选择链路（DeepSeek 有 Key 时仍选得中 codex-cli）
 *   ⑧ 能力按**后端种类**声明（与「按模型名」的预设表分开）
 *   ⑨ 接线（少一处就是「静默不生效」）
 *
 * ⚠️ 本组**不联网、不起真 codex**（只跑纯函数与假进程）。真机 E2E 见设计文档 §7。
 */

import { readFileSync, join, require, ROOT } from '../env.mjs'
import { EventEmitter } from 'node:events'
import { check, group } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')
const L = (p) => R(p).split(/\r?\n/).length

/**
 * 假的子进程 —— 喂进指定的 stdout 行，然后 close。
 * `stdin.end` 记下写了什么（自检要验「prompt 真的走 stdin」）。
 */
function fakeChild(payloadLines, opts = {}) {
  const child = new EventEmitter()
  child.pid = 4242
  child.written = ''
  child.killed = false
  child.stdout = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr = new EventEmitter()
  child.stderr.setEncoding = () => {}
  child.stdin = {
    on: () => {},
    end: (text) => {
      child.written = String(text ?? '')
    },
  }
  if (opts.silent !== true) {
    setTimeout(() => {
      for (const line of payloadLines) child.stdout.emit('data', `${line}\n`)
      if (opts.stderr) child.stderr.emit('data', opts.stderr)
      child.emit('close', opts.exitCode ?? 0)
    }, 5)
  }
  return child
}

export async function run() {
  const J = require(join(ROOT, 'electron/core/codex-jsonl.cjs'))
  const M = require(join(ROOT, 'electron/core/codex-msg.cjs'))
  const RUN = require(join(ROOT, 'electron/core/codex-run.cjs'))
  const CLI = require(join(ROOT, 'electron/core/codex-cli.cjs'))
  const K = require(join(ROOT, 'electron/core/provider-kinds.cjs'))
  const caps = require(join(ROOT, 'electron/core/provider-capabilities.cjs'))
  const parts = require(join(ROOT, 'electron/core/config-normalize-parts.cjs'))
  const defaults = require(join(ROOT, 'electron/core/config-defaults.cjs'))
  const normalize = require(join(ROOT, 'electron/core/config-normalize.cjs'))

  /* ── ① 契约同形 ── */
  group('Codex 后端 · 契约同形（复用的全部意义）')
  check('★ 适配器导出 chatStream（与 llm.chatStream 同名）', typeof CLI.chatStream === 'function')
  check('★ 分流全项目只有一处（loop-model 按 kind 选引擎）', /kinds\.isCodexCli\(target\) \? codexCli : llm/.test(R('electron/core/loop-model.cjs')))
  const llmSrc = R('electron/core/llm.cjs')
  const cliSrc = R('electron/core/codex-cli.cjs')
  for (const field of ['content', 'reasoning', 'toolCalls', 'usage', 'finishReason', 'ttftMs', 'latencyMs']) {
    check(`★ 返回值都有 ${field}（同形）`, new RegExp(`\\b${field}\\b`).test(llmSrc) && new RegExp(`\\b${field}\\b`).test(cliSrc))
  }
  for (const cb of ['onContent', 'onUsage']) {
    check(`★ 回调 ${cb} 两边都有`, llmSrc.includes(cb) && cliSrc.includes(cb))
  }
  check('★★ toolCalls 恒为空、且**不调** onToolCalls（不伪装有工具）', /toolCalls: \[\],/.test(cliSrc) && !/onToolCalls\?\./.test(cliSrc))
  check('★ 取消语义与 HTTP 路径同形（AbortError）', /DOMException\('aborted', 'AbortError'\)/.test(cliSrc))

  /* ── ② JSONL 分块 ── */
  group('Codex 后端 · JSONL 分块（子进程给的是字节流，会切在行中间）')
  const p = J.createJsonlParser()
  check('★ 半行留在缓冲区（不丢）', p.push('{"type":"a"}\n{"ty').length === 1)
  check('★ 补上后半行能解析出来', p.push('pe":"b"}\n').length === 1)
  check('一次 push 多行 → 多个事件', J.createJsonlParser().push('{"a":1}\n{"b":2}\n{"c":3}\n').length === 3)
  check('\\r\\n 兼容（Windows）', J.createJsonlParser().push('{"a":1}\r\n').length === 1)
  check('空行忽略', J.createJsonlParser().push('\n\n').length === 0)
  check('坏行跳过并计数（不抛）', (() => { const q = J.createJsonlParser(); q.push('not json\n{"ok":1}\n'); return q.stats.badLines === 1 })())
  check('★ 超长行丢弃并计数（防畸形输出吃内存）', (() => { const q = J.createJsonlParser({ maxLine: 20 }); q.push(`${'x'.repeat(60)}\n`); return q.stats.droppedLines === 1 })())
  check('flush 处理结尾无换行的最后一行', (() => { const q = J.createJsonlParser(); q.push('{"type":"last"}'); const got = q.flush(); return got.length === 1 && got[0].type === 'last' })())
  check('flush 空缓冲 → 空数组', J.createJsonlParser().flush().length === 0)
  check('非 JSON 数组（如 `[1,2]`）不当事件', J.createJsonlParser().push('[1,2]\n').length === 0)

  /* ── ③ 事件归约 ── */
  group('Codex 后端 · 事件归约（实测形状）')
  const st = J.newState()
  J.applyEvent(st, { type: 'thread.started', thread_id: 'T1' })
  J.applyEvent(st, { type: 'item.completed', item: { type: 'agent_message', text: '甲' } })
  J.applyEvent(st, { type: 'item.completed', item: { type: 'agent_message', text: '乙' } })
  J.applyEvent(st, { type: 'item.completed', item: { type: 'error', message: '配置项被忽略' } })
  J.applyEvent(st, { type: 'error', message: 'Reconnecting... 2/5' })
  J.applyEvent(st, { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5, cached_input_tokens: 90, reasoning_output_tokens: 3 } })
  check('多个 agent_message 拼起来', st.text === '甲乙')
  check('thread_id 记下了（将来 resume 用）', st.threadId === 'T1')
  check('★★ error 事件**不抛**、只记 notices（实测那是可恢复的重连提示）', st.notices.length === 2)
  check('★ usage 映射成 **OpenAI 原字段**（否则下游用量永远记 0）', st.usage.prompt_tokens === 100 && st.usage.completion_tokens === 5 && st.usage.total_tokens === 105)
  check('缓存命中 → prompt_tokens_details.cached_tokens', st.usage.prompt_tokens_details.cached_tokens === 90)
  check('思考 token → completion_tokens_details.reasoning_tokens', st.usage.completion_tokens_details.reasoning_tokens === 3)
  check('认不出的事件忽略（上游加事件不该让我们炸）', (() => { const z = J.newState(); J.applyEvent(z, { type: '外星事件' }); return z.text === '' })())
  check('usage 缺失时不崩', J.mapUsage(null).total_tokens === 0)
  check('turn.completed → finishReason=stop', CLI.finishReasonOf({ turnCompleted: true }) === 'stop')
  check('没完成 → finishReason 空串（不谎报 stop）', CLI.finishReasonOf({ turnCompleted: false }) === '')

  /* ── ④ prompt 拍平 ── */
  group('Codex 后端 · prompt 拍平（含**如实声明没有工具**）')
  const txt = M.buildPrompt([
    { role: 'system', content: '你是 Harbor' },
    { role: 'user', content: '问题一' },
    { role: 'assistant', content: '答案一' },
    { role: 'user', content: '问题二' },
  ])
  check('system 在最前', txt.startsWith('你是 Harbor'))
  check('最后一条 user 进「当前请求」', /── 当前请求 ──[\s\S]*问题二/.test(txt))
  check('更早的对话进「对话历史」', /── 对话历史[\s\S]*问题一[\s\S]*答案一/.test(txt))
  check('★★ 有工具时明说「没有可用的工具」（防它编造执行过操作）', M.buildPrompt([{ role: 'user', content: 'x' }], { tools: [{ name: 't' }] }).includes('没有可用的工具'))
  check('★ 没给工具时**不**加那句（不制造噪音）', !M.buildPrompt([{ role: 'user', content: 'x' }], { tools: [] }).includes('没有可用的工具'))
  check('多模态内容：文本取出、其余如实标注读不了', M.contentOf({ content: [{ type: 'text', text: 'hi' }, { type: 'image_url' }] }).includes('读不了'))
  check('空消息不产生空块', M.buildPrompt([{ role: 'user', content: '   ' }]) === '')

  /* ── ⑤ 进程层 ── */
  group('Codex 后端 · 进程层（安全底线）')
  check('★★ 沙箱固定 read-only（开可写 = 绕过 Harbor 审批直接改用户文件）', RUN.SANDBOX === 'read-only' && RUN.EXEC_ARGS.includes('read-only'))
  check('★★ prompt 走 stdin（命令行末尾是 `-`）', RUN.EXEC_ARGS[RUN.EXEC_ARGS.length - 1] === '-')
  check('★★ 参数表里全是常量（没有任何用户内容的位置）', RUN.EXEC_ARGS.every((a) => !/[;&|%<>]/.test(a)))
  check('命令行只拼 launcher + 常量参数', RUN.buildCommandLine('C:\\a b\\codex.cmd').endsWith('exec --json -s read-only --skip-git-repo-check -'))
  const spec = RUN.spawnSpec('codex.cmd')
  if (process.platform === 'win32') {
    check('★ Windows 经 cmd.exe（.cmd 不能直接 spawn）', /cmd\.exe/i.test(spec.cmd))
    check('★★ 用 windowsVerbatimArguments 且**不是** shell:true（否则用户内容会被 cmd 解析）', spec.verbatim === true && spec.args[0] === '/d')
  }
  check('★ codexPath 显式给了就优先用它（不硬编码本机路径）', RUN.resolveLauncher('E:\\x\\my-codex.cmd') === 'E:\\x\\my-codex.cmd')
  check('★ 没给就在 PATH 里解析出 codex 启动器', /codex($|\.cmd$|\.exe$)/.test(RUN.resolveLauncher('')))
  const killArgs = (() => { let a = null; RUN.killTree(9999, { spawnFn: (_c, args) => { a = args; return { unref() {} } } }); return a })()
  check('★★ 取消按 **pid + /T** 杀树', Boolean(killArgs) && killArgs.includes('/pid') && killArgs.includes('9999') && killArgs.includes('/T'))
  check('★★ **绝不**按映像名杀（/IM 会误杀用户正开着的窗口）', Boolean(killArgs) && !killArgs.includes('/IM'))
  check('非法 pid 不发杀进程指令', RUN.killTree(0, { spawnFn: () => ({}) }) === false)

  /* ── ⑥ 取消与超时（真跑 runCodex + 假 spawn）── */
  group('Codex 后端 · 取消与超时（真跑 runCodex，注入假进程）')
  const okLines = [
    '{"type":"thread.started","thread_id":"T"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"你好"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ]
  const r1 = await RUN.runCodex({ launcher: 'codex.cmd', prompt: 'hi', spawnFn: () => fakeChild(okLines) })
  check('正常一轮：拿到事件 + exitCode 0', r1.events.length === 3 && r1.exitCode === 0 && !r1.timedOut && !r1.aborted)
  check('★ 假进程收到的 stdin 就是 prompt（证明 prompt 走 stdin）', (() => { const c = fakeChild(okLines); void RUN.runCodex({ launcher: 'x', prompt: '我的提问', spawnFn: () => c }); return c.written === '我的提问' })())

  const ctrl = new AbortController()
  const r2p = RUN.runCodex({ launcher: 'x', prompt: 'hi', signal: ctrl.signal, spawnFn: () => fakeChild([], { silent: true }) })
  ctrl.abort()
  const r2 = await r2p
  check('★ 取消 → aborted=true（不当作正常结束）', r2.aborted === true)
  check('★ 取消后仍会收束（不悬挂）', typeof r2.exitCode !== 'undefined')

  const r3 = await RUN.runCodex({ launcher: 'x', prompt: 'hi', idleMs: 30, spawnFn: () => fakeChild([], { silent: true }) })
  check('★ 无输出 → 超时（idle 看门狗触发）', r3.timedOut === true)

  const r4 = await RUN.runCodex({ launcher: 'x', prompt: 'hi', spawnFn: () => { const e = new Error('ENOENT'); throw e } })
  check('★ 起不来 → spawnError 如实带回（不抛）', Boolean(r4.spawnError) && r4.events.length === 0)
  check('★ 起不来时也收束', r4.exitCode === null)

  const r5 = await RUN.runCodex({ launcher: 'x', prompt: 'hi', spawnFn: () => fakeChild(['not json', '{"type":"turn.started"}'], { stderr: '警告一行' }) })
  check('坏行被跳过、其余事件照常（1 坏 + 1 好）', r5.events.length === 1 && r5.events[0].type === 'turn.started')
  check('stderr 记了尾部（空输出时用它说清原因）', r5.stderrTail.includes('警告'))

  /* ── ⑦ 配置向后兼容 + 选择链路 ── */
  group('Codex 后端 · 配置向后兼容与选择链路')
  const oldP = parts.normalizeProvider({ id: 'deepseek', baseUrl: 'https://x', models: ['m'] }, 0)
  check('★★ 旧配置无 kind → openai（默认值即兼容，不写迁移）', oldP.kind === 'openai')
  check('旧配置 codexPath → 空串', oldP.codexPath === '')
  check('不认识的 kind → 回落 openai（不信任输入）', parts.normalizeProvider({ id: 'z', kind: 'weird' }, 1).kind === 'openai')
  check('显式 codex-cli 保留', parts.normalizeProvider({ id: 'c', kind: 'codex-cli' }, 2).kind === 'codex-cli')
  const codexPreset = defaults.DEFAULTS.providers.find((p) => p.id === 'codex-cli')
  check('★ 默认列表含 codex-cli 且 **enabled:false**（不启用不影响任何人）', Boolean(codexPreset) && codexPreset.enabled === false)
  check('★★ codex-cli 预设**没有任何凭据字段**（不复制 ChatGPT 登录）', codexPreset && !codexPreset.credentialRef && !codexPreset.apiKey)
  check('★ 默认列表第一条仍是 deepseek（默认后端没变）', defaults.DEFAULTS.providers[0].id === 'deepseek')
  check('★ 空配置 → 默认两条', normalize.normalize({}).providers.length === 2)
  check('★★ 用户已有 providers → **不补默认**（老用户配置一字不变）', normalize.normalize({ providers: [{ id: 'deepseek', baseUrl: 'https://x' }] }).providers.length === 1)
  check('★ needsKey：codex-cli 不需要 Key，其余需要', K.needsKey({ kind: 'codex-cli' }) === false && K.needsKey({ kind: 'openai' }) === true && K.needsKey({}) === true)
  const cfgSrc = R('electron/core/config.cjs')
  check('★★ providerForModel 把「不需要 Key」的后端算进候选（否则用户选了它会被**静默换成** DeepSeek）', /kinds\.needsKey\(p\)/.test(cfgSrc))
  check('★ 没 Key 会在发请求前被误报 —— loop-route 已放行', /kinds\.needsKey\(provider\) && !configCore\.hasKey\(provider\)/.test(R('electron/core/loop-route.cjs')))
  check('★ config.hasKey 本身**没被改**（旁路继续跳过 codex-cli，这是有意的）', /function hasKey\(provider\) \{\s*return Boolean\(provider\?\.credentialRef\) && credentials\.has\(provider\.credentialRef\)/.test(cfgSrc))

  /* ── ⑧ 能力按后端种类声明 ── */
  group('Codex 后端 · 能力独立声明（传输方式 ≠ 模型能力）')
  const byKind = caps.capsForKind({ kind: 'codex-cli' })
  check('★ codex-cli 声明 tool_call:false（不伪装支持工具调用）', byKind.caps.tool_call === false)
  check('★ codex-cli 声明 streaming:false（item 级，不是逐字）', byKind.caps.streaming === false)
  check('codex-cli 声明 chat:true', byKind.caps.chat === true)
  check('★ 这条声明自成一格（不冒充某个模型的预设）', byKind.preset === 'codex-cli-backend' && /codex/.test(byKind.presetNote))
  check('★★ openai 后端 → 返回 null（继续走按模型名的预设表，行为不变）', caps.capsForKind({ kind: 'openai' }) === null && caps.capsForKind({}) === null)
  check('openai 路径的预设表不受影响（deepseek tool_call 仍 true）', caps.resolve('deepseek-chat', {}).caps.tool_call === true)
  check('★ 用户手填覆盖仍优先（既有优先级没被改）', caps.resolve('codex-cli', { tool_call: true }, { kind: 'codex-cli' }).caps.tool_call === true)
  check('★ forProviders 会按 kind 算（界面那张矩阵才准）', caps.forProviders([{ id: 'c', kind: 'codex-cli', models: ['codex-cli'] }]).models['codex-cli'].caps.tool_call === false)

  /*
   * ── ⑩ 辅助任务模型分离（2026-10-17）──
   *
   * 真机病：主任务能选 codex-cli（baseUrl 空串），而压缩 / 复核调的是 llm.chatStream ——
   * 沿用主任务 provider 就必然拿空 baseUrl 发请求 → 必失败。这组的判据是
   * 「辅助活自己挑一个能走 HTTP 的后端」，而不是跟着主任务一起坏。
   */
  group('Codex 后端 · 辅助任务不复用主任务后端（压缩 / 复核）')
  const AUX = require(join(ROOT, 'electron/core/aux-model.cjs'))
  const CLI_P = { id: 'codex-cli', kind: 'codex-cli', baseUrl: '', enabled: true, models: ['codex-cli'] }
  const HTTP_P = { id: 'deepseek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', enabled: true, models: ['deepseek-chat'] }
  const keyOf = (p) => p.id === 'deepseek'
  check('★ canHttp：codex-cli 不算「能走 HTTP」（它没有 baseUrl）', K.canHttp(CLI_P, keyOf) === false)
  check('★ canHttp：有 baseUrl + 有 Key 的 openai 才算', K.canHttp(HTTP_P, keyOf) === true)
  check('★ canHttp：没注入 hasKey 判据时**保守拒绝**（不拿空 Key 去发请求）', K.canHttp(HTTP_P, undefined) === false)
  const auxCfg = { providers: [HTTP_P, CLI_P], assistant: { model: 'codex-cli' }, scenes: {} }
  const picked = AUX.resolveAux(auxCfg, { scene: 'compact', hasKey: keyOf })
  check('★★ 主任务选 codex-cli 时，辅助任务挑到 HTTP 后端（不是 codex-cli）', picked?.provider.id === 'deepseek', JSON.stringify(picked?.provider?.id))
  check('★ 辅助模型名不复用主任务那个（退到对方能提供的）', picked?.model === 'deepseek-chat', picked?.model)
  check(
    '★★ 一个 HTTP 后端都没有 → null（**不回退**到那个必失败的 CLI 后端）',
    AUX.resolveAux({ providers: [CLI_P], assistant: { model: 'codex-cli' }, scenes: {} }, { scene: 'compact', hasKey: keyOf }) === null,
  )
  check(
    '★ 场景显式配置优先（`scenes` 就是「辅助模型」的现成入口，不新造字段）',
    AUX.resolveAux(
      { ...auxCfg, scenes: { compact: { providerId: 'deepseek', model: 'deepseek-reasoner' } } },
      { scene: 'compact', hasKey: keyOf },
    )?.model === 'deepseek-reasoner',
  )
  check(
    '★ 主任务是 DeepSeek 时辅助任务照旧选它（回归未破）',
    AUX.resolveAux({ ...auxCfg, assistant: { model: 'deepseek-chat' } }, { scene: 'compact', hasKey: keyOf })?.model === 'deepseek-chat',
  )
  check(
    '★★ 接线：compactMessages 用 resolveAux，且不再吃主任务那个 provider',
    /auxModel\.resolveAux\(config, \{ scene: 'compact' \}\)/.test(R('electron/core/loop-model.cjs')) &&
      !/compactMessages\(\{ \.\.\.options, provider: target \}\)/.test(R('electron/core/loop-model.cjs')),
  )
  check('★ 接线：reviewWithEvents 把 aux.provider 交给 selfReview', /provider: aux\.provider/.test(R('electron/core/loop-model.cjs')))
  check(
    '★ 辅助判据只有一处（aux-model 不自己判 kind —— 硬约束 #9）',
    !/isCodexCli|kind === 'codex-cli'/.test(R('electron/core/aux-model.cjs')),
  )

  /* ── ⑪ 接线 ── */
  group('Codex 后端 · 接线（少一处就是「静默不生效」）')
  check('★ loop-model 真的 require 了适配器', /require\('\.\/codex-cli\.cjs'\)/.test(R('electron/core/loop-model.cjs')))
  check('★ 配置层把 kind 写进白名单（不写会被静默丢掉）', /kind: pick\(str\(p\.kind\)/.test(R('electron/core/config-normalize-parts.cjs')))
  check('★ 界面类型有 kind / codexPath', /kind\?: 'openai' \| 'codex-cli'/.test(R('src/types/models.ts')))
  check('★ 界面有「添加 Codex CLI」入口（老用户否则选不到）', /addCodexProvider/.test(R('src/stores/useConfigStore.ts')) && /AddCodex|addCodex/.test(R('src/components/settings/ProviderPanel.tsx')))
  check('★★ 能力限制写在**用户看得见的地方**（卡片正文，不是注释）', /不支持 Harbor 的工具调用/.test(R('src/components/settings/providers/CodexCliCard.tsx')))
  check('★ 没动工具执行链（模型只产 toolCalls，执行在 tools/ —— 这条后端不产，所以自然不调）', !/codex/i.test(R('electron/core/tools/index.cjs')))

  /* ── 行数（贴线是这一批最容易踩的） ── */
  group('Codex 后端 · 行数（≤300）')
  for (const f of [
    'electron/core/codex-jsonl.cjs',
    'electron/core/codex-msg.cjs',
    'electron/core/codex-run.cjs',
    'electron/core/codex-cli.cjs',
    'electron/core/provider-kinds.cjs',
    'electron/core/config-codex-preset.cjs',
    'electron/core/aux-model.cjs',
    'electron/core/config.cjs',
    'electron/core/config-defaults.cjs',
    'electron/core/loop-model.cjs',
    'electron/core/provider-capabilities.cjs',
    'src/components/settings/providers/CodexCliCard.tsx',
    'src/components/settings/ProviderPanel.tsx',
  ]) {
    const n = L(f)
    check(`${f} = ${n} 行`, n <= 300, String(n))
  }
}
