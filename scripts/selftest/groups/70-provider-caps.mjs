import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   Provider 能力矩阵：声明 + 预设 + 覆盖 + 缺口

   这一组要钉住的是**几件容易走样的事**：

     ① 维度名单就那十个，且**界面上看到的那句话**（LABELS / NOTE）没有别的来源
     ② 预设只写「查得到的」，**不确定的是 null 不是 false**
     ③ 未知模型返回**全未知** —— 不许给它编一套默认能力（这是最容易犯的错：
        「没有预设就当它支持」会让界面显示一句肯定的假话）
     ④ 用户覆盖 > 内置预设 > 未知，两种覆盖写法都认
     ⑤ `missing()` 把「明确不支持」和「说不准」分开
     ⑥ 这个模块**不联网、不 require electron**（自检能跑起来的前提）

   注意：这一组**没有**注册进 scripts/selftest.mjs（按本轮任务要求），
   单独跑法：
     node -e "import('./scripts/selftest/groups/70-provider-caps.mjs').then(m=>m.run())"
   ══════════════════════════════════════════════════════════════ */

const caps = require(join(ROOT, 'electron/core/provider-capabilities.cjs'))
const presets = require(join(ROOT, 'electron/core/provider-presets.cjs'))
const configModule = require(join(ROOT, 'electron/core/config.cjs'))

const EXPECTED_DIMS = [
  'chat',
  'streaming',
  'tool_call',
  'vision',
  'structured_output',
  'reasoning',
  'context_window',
  'max_output',
  'attachments',
  'search',
]

export async function run() {
  /* ── 结构 ───────────────────────────────────────────────── */

  group('Provider 能力 / 维度与词汇')
  check(
    '维度就是约定的那十个（顺序也算）',
    caps.DIMENSIONS.join(',') === EXPECTED_DIMS.join(','),
    caps.DIMENSIONS.join(','),
  )
  check(
    '每个维度都有中文名',
    caps.DIMENSIONS.every((dim) => typeof caps.LABELS[dim] === 'string' && caps.LABELS[dim]),
  )
  check(
    '★ 每个维度都有中文名',
    caps.DIMENSIONS.every((dim) => Boolean(caps.LABELS[dim])),
    JSON.stringify(caps.LABELS),
  )
  check('数值维度只有 context_window / max_output', caps.NUMERIC_DIMS.join(',') === 'context_window,max_output')
  check(
    '★ 「这是声明不是探测」那句话写在 NOTE 里，且明确说了没做探测',
    /声明/.test(caps.NOTE) && /不是探测/.test(caps.NOTE) && /没做|未做|没做探测/.test(caps.NOTE),
    caps.NOTE,
  )

  /* ── 预设表本身 ─────────────────────────────────────────── */

  group('Provider 能力 / 内置预设')
  const list = presets.list()
  check('有预设', list.length >= 20, String(list.length))
  check('id 不重复', new Set(list.map((p) => p.id)).size === list.length)
  check(
    '每条都有 匹配规则 / 能力 / 依据',
    list.every((p) => p.test instanceof RegExp && p.caps && p.note),
  )
  check(
    '★ 每条都写了依据（note 非空）—— 预设会过期，用户得能看出结论是哪来的',
    list.every((p) => typeof p.note === 'string' && p.note.length >= 6),
    JSON.stringify(list.filter((p) => !p.note || p.note.length < 6).map((p) => p.id)),
  )
  check(
    '★ 预设里不出现不认识的维度名',
    list.every((p) => Object.keys(p.caps).every((dim) => EXPECTED_DIMS.includes(dim))),
    JSON.stringify(list.flatMap((p) => Object.keys(p.caps)).filter((d) => !EXPECTED_DIMS.includes(d))),
  )
  check('list() 给的是副本（改了不影响内核那份）', (() => {
    const copy = presets.list()
    copy[0].caps.chat = '被改了'
    copy[0].id = '被改了'
    return presets.list()[0].caps.chat !== '被改了' && presets.list()[0].id !== '被改了'
  })())

  group('Provider 能力 / 命中与归一化')
  const chat = caps.resolve('deepseek-chat')
  check('deepseek-chat 支持工具调用', chat.caps.tool_call === true, JSON.stringify(chat.caps))
  check('deepseek-chat 上下文是 64K', chat.caps.context_window === 65_536, String(chat.caps.context_window))
  check('deepseek-chat 不读图', chat.caps.vision === false)
  check(
    '★ deepseek-reasoner 明确标了不支持工具调用（这条最容易忘，忘就是「工具没反应」）',
    caps.resolve('deepseek-reasoner').caps.tool_call === false,
  )
  check('deepseek-reasoner 标了推理', caps.resolve('deepseek-reasoner').caps.reasoning === true)
  check('gpt-4o 读图', caps.resolve('gpt-4o').caps.vision === true)
  check(
    '★ 归一化：vendor 前缀 / :tag / 大小写都不影响命中',
    presets.normalizeName('DeepSeek/deepseek-chat:free') === 'deepseek-chat' &&
      presets.normalizeName('llama3.1:8b') === 'llama3.1' &&
      caps.resolve('deepseek/deepseek-chat:free').caps.tool_call === true,
  )
  check(
    '★ 顺序：gpt-4o-mini 命中 mini 那条，没被 gpt-4o 的宽规则吃掉',
    presets.match('gpt-4o-mini').id === 'openai-gpt-4o-mini',
    String(presets.match('gpt-4o-mini').id),
  )
  check(
    '★ 顺序：glm-4v 走视觉那条，没被 glm 家族吃掉',
    caps.resolve('glm-4v').caps.vision === true,
    JSON.stringify(presets.match('glm-4v').id),
  )
  check(
    '「不是对话模型」能认出来（拿它聊天会 400）',
    caps.resolve('text-embedding-3-large').caps.chat === false &&
      caps.resolve('whisper-1').caps.chat === false,
  )

  group('Provider 能力 / 未知模型')
  const unknown = caps.resolve('某个中转站的-神秘模型-9x')
  check(
    '★ 未知模型返回**全未知**，不是瞎猜「支持」',
    Object.values(unknown.caps).every((value) => value === null),
    JSON.stringify(unknown.caps),
  )
  check('未知模型没有预设 id', unknown.preset === null)
  check(
    '未知模型的每一维都标了 unknown（界面据此显示「未知」而不是「不支持」）',
    Object.values(unknown.source).every((from) => from === 'unknown'),
  )
  check('空模型名也不会炸', Object.values(caps.resolve('').caps).every((v) => v === null))
  check('脏输入不会炸（null / 数字 / 数组）', (() => {
    const a = caps.resolve(null)
    const b = caps.resolve(42)
    const c = caps.resolve('deepseek-chat', 'not-an-object')
    return a.preset === null && b.caps.chat === null && c.caps.tool_call === true
  })())

  group('Provider 能力 / 用户覆盖优先')
  const flat = caps.resolve('deepseek-chat', { vision: true })
  check('★ 覆盖 > 预设：手填说能读图，就是能读图', flat.caps.vision === true)
  check('这一票记成 override（界面能看出是手填的）', flat.source.vision === 'override')
  check('没覆盖的维度仍然来自预设', flat.source.tool_call === 'preset')
  const grouped = caps.resolve('deepseek-chat', { 'deepseek-chat': { vision: true } })
  check('★ 按模型分组的写法也认（配置里存的就是这个形状）', grouped.caps.vision === true)
  const other = caps.resolve('deepseek-chat', { '别的模型': { vision: true } })
  check('★ 别人的覆盖不会串台', other.caps.vision === false, String(other.caps.vision))
  const bad = caps.resolve('deepseek-chat', { vision: 'yes', context_window: -1, 乱写: true })
  check('★ 非法值被丢掉（不是布尔 / 不是正数），不会污染结果',
    bad.caps.vision === false && caps.resolve('mystery-x', { context_window: -1 }).caps.context_window === null)
  check('空覆盖等于没覆盖', caps.resolve('deepseek-chat', {}).caps.vision === false)

  group('Provider 能力 / 缺口（提前警告用）')
  const reasoner = caps.missing('deepseek-reasoner', ['tool_call', 'streaming'])
  check('★ 算出缺口：reasoner 缺工具调用', reasoner.missing.join(',') === 'tool_call', JSON.stringify(reasoner.missing))
  check('缺了就是 ok=false', reasoner.ok === false)
  check('没缺的那项不报', reasoner.missing.includes('streaming') === false)
  check('deepseek-chat 干这两样活不缺东西', caps.missing('deepseek-chat', ['tool_call', 'streaming']).ok === true)
  const unsure = caps.missing('神秘模型-9x', ['vision'])
  check('★ 「说不准」和「明确不支持」分开：unknown 里有、missing 里没有',
    unsure.unknown.join(',') === 'vision' && unsure.missing.length === 0 && unsure.ok === true,
    JSON.stringify(unsure))
  check('不认识的维度名被忽略', caps.missing('deepseek-chat', ['不识别的维度']).needs.length === 0)
  check('覆盖会影响缺口判断', caps.missing('deepseek-reasoner', ['tool_call'], { tool_call: true }).ok === true)

  group('Provider 能力 / 下发形状')
  const matrix = caps.forProviders([
    { id: 'a', models: ['deepseek-chat', 'mystery-x'], modelCapabilities: { 'mystery-x': { vision: true } } },
    { id: 'b', models: ['deepseek-chat', 'gpt-4o', ''] },
  ])
  check('带上十个维度与中文名', matrix.dims.length === 10 && Boolean(matrix.labels.vision))
  check('★ 带上那句「声明不是探测」（界面直接显示，不许自己另写一句）', matrix.note === caps.NOTE)
  check('去重：同名模型只算一次', Object.keys(matrix.models).filter((m) => m === 'deepseek-chat').length === 1)
  check('空模型名不进表', Boolean(matrix.models['']) === false)
  check('覆盖跟着矩阵一起下发', matrix.models['mystery-x'].caps.vision === true)
  check('没声明的模型不在矩阵里（界面会什么都不显示，而不是显示「未知」）', matrix.models['gpt-3.5-turbo'] === undefined)
  check('脏 providers 不会炸', caps.forProviders(null).models && Object.keys(caps.forProviders(null).models).length === 0)

  group('Provider 能力 / 配置联动')
  const normalized = configModule.normalize({
    providers: [
      {
        id: 'x',
        baseUrl: 'http://localhost:11434/v1',
        models: ['deepseek-chat'],
        modelCapabilities: { 'deepseek-chat': { vision: true, context_window: 32_000, 乱写: 1, tool_call: 'yes' } },
      },
    ],
  })
  const kept = normalized.providers[0].modelCapabilities
  check('★ 规范化层没把手填覆盖丢掉（丢了就是「改了没生效还不报错」）', kept['deepseek-chat']?.vision === true)
  check('合法的数字留下', kept['deepseek-chat']?.context_window === 32_000)
  check('不认识的维度 / 非法值被丢掉', kept['deepseek-chat']?.乱写 === undefined && kept['deepseek-chat']?.tool_call === undefined)
  check('没手填的 provider 也有这个字段（形状稳定）', normalized.providers[0].modelCapabilities !== undefined)
  const rendered = configModule.forRenderer()
  check('★ config:get 下发的载荷里带 capabilities', Boolean(rendered.capabilities?.models))
  check('默认供应商的 deepseek-chat 能在矩阵里查到', Boolean(rendered.capabilities.models['deepseek-chat']))
  check(
    '预设能覆盖到默认的两条模型（deepseek-chat / deepseek-reasoner）',
    Boolean(rendered.capabilities.models['deepseek-chat'] && rendered.capabilities.models['deepseek-reasoner']),
  )

  group('Provider 能力 / 不联网 · 不碰 electron')
  const sources = ['provider-capabilities.cjs', 'provider-presets.cjs']
    .map((name) => readFileSync(join(ROOT, 'electron/core', name), 'utf8'))
    .join('\n')
  check('★ 不 require electron（自检能跑起来的前提）', sources.includes("require('electron')") === false)
  check('★ 不发网络请求（这一轮不做探测）', sources.includes('fetch(') === false && sources.includes('node:http') === false)
  check('★ 文件头写明「声明不是探测」', /声明/.test(sources) && /不是探测/.test(sources))
}
