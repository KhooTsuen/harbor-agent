import { join, readFileSync, ROOT, require } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   会话级模型（2026-09-28 用户报的 bug 的回归）

   现象：「新建对话选择 gpt 模型但还是使用的 Deepseek flash 模型」。

   根因是**两处都没接上**：
     · 渲染层的模型选择器只写 `thread.model`（也落会话 meta），发送时**没带**；
     · 内核 `handlers/chat.cjs` **从不读** payload.model，模型一直是全局
       `config.assistant.model`。
   于是「选了什么、界面上写着什么」和「实际用谁」是两码事，而且**一声不吭**
   —— 这正是用户说的「看似可用但实际无法正常使用」。

   这一组钉四件事：
     · 注入规则本身（`model-select.withRequestedModel`，纯函数）
     · 注入后供应商按**模型**挑（`config.providerForModel(model, cfg)`）
     · 四个接口点真的接上了（源码钉子 —— 少一处就退回那个 bug）
   ══════════════════════════════════════════════════════════════ */

const modelSelect = require(join(ROOT, 'electron/core/model-select.cjs'))
const configCore = require(join(ROOT, 'electron/core/config.cjs'))

/** 造两个供应商：A 有 key 但不提供目标模型，B 有 key 且提供 —— 应该挑 B */
function twoProviders() {
  return [
    {
      id: 'p-a',
      name: 'A 站',
      baseUrl: 'https://a.invalid/v1',
      credentialRef: 'provider:selftest-model-choice-a',
      models: ['model-a'],
      enabled: true,
    },
    {
      id: 'p-b',
      name: 'B 站',
      baseUrl: 'https://b.invalid/v1',
      credentialRef: 'provider:selftest-model-choice-b',
      models: ['model-b', 'gpt-5.5'],
      enabled: true,
    },
  ]
}

export async function run() {
  const credentials = require(join(ROOT, 'electron/core/credentials.cjs'))
  credentials.set('provider:selftest-model-choice-a', 'sk-selftest-a-123456')
  credentials.set('provider:selftest-model-choice-b', 'sk-selftest-b-123456')

  /* ── ① 注入规则 ─────────────────────────────────────── */
  group('会话级模型 / 注入规则')
  const providers = twoProviders()
  const baseConfig = {
    ...configCore.get(),
    providers,
    assistant: { ...configCore.get().assistant, model: 'deepseek-flash' },
  }

  const scoped = modelSelect.withRequestedModel(baseConfig, 'gpt-5.5')
  check(
    '★ 会话里选了就盖过全局（以前内核根本不看它）',
    scoped.config.assistant.model === 'gpt-5.5' && scoped.scoped === true,
    `实到 ${scoped.config.assistant.model}`,
  )
  check(
    '原配置对象不被改（配置是共享的，改了会串到别处）',
    baseConfig.assistant.model === 'deepseek-flash',
    baseConfig.assistant.model,
  )
  check('其它字段照旧带过去（不做多余裁剪）', scoped.config.providers === providers)

  const unscoped = modelSelect.withRequestedModel(baseConfig, '')
  check(
    '没带模型 → 用全局，且不复制对象',
    unscoped.model === 'deepseek-flash' && unscoped.scoped === false && unscoped.config === baseConfig,
  )
  check(
    '非字符串 / 只有空格也当没带（脏值不能把模型名搞坏）',
    modelSelect.withRequestedModel(baseConfig, undefined).scoped === false &&
      modelSelect.withRequestedModel(baseConfig, '   ').scoped === false &&
      modelSelect.withRequestedModel(baseConfig, 42).scoped === false,
  )
  check('带空格的名字会 trim', modelSelect.withRequestedModel(baseConfig, ' gpt-5.5 ').model === 'gpt-5.5')

  /* ── ② 供应商按模型挑 ───────────────────────────────── */
  group('会话级模型 / 供应商按模型挑')
  const forB = configCore.providerForModel('gpt-5.5', { providers })
  check(
    '★ 挑的是**真的提供这个模型**的那家（不是「第一个有 key 的」）',
    forB?.id === 'p-b',
    `实到 ${forB?.id}`,
  )
  const forA = configCore.providerForModel('model-a', { providers })
  check('另一个模型挑到另一家', forA?.id === 'p-a', `实到 ${forA?.id}`)
  const unknown = configCore.providerForModel('谁都没声明的模型', { providers })
  check('谁都没声明 → 退回候补（旧行为，不炸）', unknown?.id === 'p-a', `实到 ${unknown?.id}`)
  const empty = configCore.providerForModel('', { providers })
  check('模型为空 → 走 activeProvider（旧行为）', empty !== null)

  /* ── ③ 四个接口点真接上了（源码钉子）───────────────── */
  group('会话级模型 / 四个接口点')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check(
    '★ chat.cjs 用 withRequestedModel 注入（而不是只读全局 config）',
    chatSrc.includes('withRequestedModel(current, payload?.model)'),
  )
  check(
    '★ loop.run 收到的是注入后的配置',
    /loop\.run\(\{[\s\S]*?config: effective/.test(chatSrc),
    'chat.cjs 里应为 config: effective',
  )
  check(
    '日志里说得出用的是哪个模型、来自会话还是全局',
    chatSrc.includes('（会话级）') && chatSrc.includes('（全局默认）'),
  )

  const loopSrc = readFileSync(join(ROOT, 'electron/core/loop.cjs'), 'utf8')
  check(
    '★ 循环里的「有没有 key」按模型挑供应商（providerForRun）',
    loopSrc.includes('providerForRun(config)'),
  )
  const routeSrc = readFileSync(join(ROOT, 'electron/core/loop-route.cjs'), 'utf8')
  check(
    'providerForRun 把 config 一起交给 providerForModel（看同一份配置）',
    routeSrc.includes('providerForModel(config.assistant.model, config)'),
  )
  const compactSrc = readFileSync(join(ROOT, 'electron/handlers/compact.cjs'), 'utf8')
  check(
    '压缩那条路也按会话模型挑供应商（不然换了模型压缩会 400）',
    compactSrc.includes('config.providerForModel(requestedModel)'),
  )

  const turnsSrc = readFileSync(join(ROOT, 'src/stores/thread/turns.ts'), 'utf8')
  check(
    '★★ 渲染层**真的把模型发给内核**（这个 bug 的第一处断点）',
    /\{ model: thread\.model \}/.test(turnsSrc),
    'sendChat payload 里应有 model',
  )
  const pickerSrc = readFileSync(join(ROOT, 'src/components/chat/Composer.tsx'), 'utf8')
  check(
    '选择器写的还是会话自己的 model（会话级，不是改全局）',
    pickerSrc.includes('setThreadModel(activeThreadId, id)'),
  )

  /*
   * ── ④ 真机才逮到的一类错：把「模块函数」当成「配置对象上的方法」──
   *
   * `activeProvider` 是 `core/config.cjs` **模块**上的函数；从 `config.get()` 拿到的
   * 配置对象上**没有**这个字段。我在这里犯过一次：把 `config.activeProvider()` 顺手
   * 改成 `effective.activeProvider()`（为了按会话级模型挑供应商），
   * **tsc 全绿、lint 全绿、2776 项自检全绿** —— 真机上一发消息就
   * `TypeError: effective.activeProvider is not a function`，消息直接发不出去。
   *
   * 所以加一条**通用**钉子：全仓扫一遍，任何 `X.activeProvider()` 里的 X
   * 只准是模块别名（config / configCore）。这样以后再有同类写法，自检当场红。
   */
  const fsMod = require('node:fs')
  const electronFiles = []
  const walk = (dir) => {
    for (const entry of fsMod.readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.cjs')) electronFiles.push(full)
    }
  }
  walk(join(ROOT, 'electron'))

  const wrong = []
  for (const file of electronFiles) {
    const src = readFileSync(file, 'utf8')
    for (const hit of src.matchAll(/([A-Za-z_$][\w$]*)\.activeProvider\(/g)) {
      if (hit[1] !== 'config' && hit[1] !== 'configCore') {
        wrong.push(`${file.slice(ROOT.length + 1).replace(/\\/g, '/')}: ${hit[0]}`)
      }
    }
  }
  check(
    '★ 没把 activeProvider 当配置对象的方法调（真机直接 TypeError，自检当时全绿）',
    wrong.length === 0,
    wrong.join('; ') || `扫了 ${electronFiles.length} 个 .cjs`,
  )
  check(
    '★ chat.cjs 的供应商预检也按会话模型挑（不然预检和实际用的不是一家）',
    chatSrc.includes('config.providerForModel(effective.assistant.model)'),
  )
}
