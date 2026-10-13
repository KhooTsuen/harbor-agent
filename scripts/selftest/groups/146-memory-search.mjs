/**
 * 自检 / 只读工具 memory_search（2026-10-13）
 *
 * 症结：记忆每轮只把最相关的那几条注入系统提示，模型**看不到**其余条目、也没有「取更多」的入口。
 * 设置页那个 `memory:search` 是 **IPC 通道**（渲染层用），模型侧**够不着** —— `tools/` 里此前
 * 只有「写」的 `remember`，没有「读」的。这个工具补上那只读的手。
 * 设计：docs/research/memory-layered-recall-design.md（阶段 1）。
 *
 * 要钉死的事实：
 *   · **接线对** —— 已注册进 ALL、出现在 toApiSchema（写好了没人调 = 白做）；
 *   · **只读** —— 不进 WRITE_TOOLS（否则 ask 档每次搜都弹框；readonly 档也要能用）；
 *   · **能用** —— 能搜到、返回带 id、能按 projectId 过滤、空查询不炸；
 *   · **指路在** —— memory-recall 的注入文案提到 memory_search（模型现在唯一读得到的指路）。
 */

import { check, group } from '../harness.mjs'
import { join, memory, promptStackCore, readFileSync, require, ROOT, tools } from '../env.mjs'

const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))

export async function run() {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
  const spill = []
  const ctx = (over = {}) => ({
    workdir: ROOT,
    permission: 'full',
    log: console,
    sessionId: 'selftest-memsearch',
    taskId: 'selftest-task',
    ...over,
  })

  group('memory_search / 接线（防「写好了没人调 / 放错名单」）')
  check('★ 已注册进 ALL', registry.ALL.some((x) => x.name === 'memory_search'))
  check(
    '★ **不在** WRITE_TOOLS（只读：ask 档不该每搜一次弹一次框）',
    !registry.WRITE_TOOLS.has('memory_search'),
  )
  check(
    '★ 工具 schema 真的送到模型面前（toApiSchema 里有它）',
    tools.toApiSchema().some((t) => t.function.name === 'memory_search'),
  )

  group('memory_search / 参数校验')
  const props =
    tools.toApiSchema().find((t) => t.function.name === 'memory_search')?.function?.parameters
      ?.properties ?? {}
  check('query 是必填字符串', props.query?.type === 'string')
  check('limit 是可选的整数', props.limit?.type === 'integer')
  check(
    '缺 query → 参数校验拦下',
    String(await tools.execute('memory_search', {}, ctx())).includes('参数不合法'),
    String(await tools.execute('memory_search', {}, ctx())).slice(0, 60),
  )
  check('带 query 能过校验', tools.validateArgs(registry.byName('memory_search'), { query: 'x' }).length === 0)

  group('memory_search / 能搜到（含 id）')
  const a = memory.add({
    content: '自检临时：搜索引擎测试用的独特关键词 zyzzyx-alpha',
    type: 'fact',
    scope: 'global',
  })
  if (a.item?.id) spill.push(a.item.id)

  const hit = await tools.execute('memory_search', { query: 'zyzzyx-alpha' }, ctx())
  check('搜到了刚写的那条', String(hit).includes('zyzzyx-alpha'), String(hit).slice(0, 80))
  check('★ 返回里带 id（模型能据此引用）', String(hit).includes(String(a.item?.id)), String(hit).slice(0, 120))
  check('返回用类型标签（[事实] 之类）', String(hit).includes('[') && String(hit).includes(']'))

  const miss = await tools.execute('memory_search', { query: '绝对搜不到的词条-zzz-qqq' }, ctx())
  check('搜不到时返回「没搜到」而不是空/异常', String(miss).includes('没搜到'), String(miss).slice(0, 60))

  group('memory_search / 空查询不炸')
  const blank = await tools.execute('memory_search', { query: '   ' }, ctx())
  check('★ 空/空白查询返回错误文本（不抛异常炸掉模型循环）', String(blank).startsWith('错误：'), String(blank).slice(0, 60))

  group('memory_search / 按 projectId 过滤（与注入口径一致）')
  const p = memory.add({
    content: '自检临时：项目作用域记忆 zyzzyx-proj',
    type: 'fact',
    scope: 'project',
    projectId: 'selftest-proj-A',
  })
  if (p.item?.id) spill.push(p.item.id)

  const inSame = await tools.execute('memory_search', { query: 'zyzzyx-proj' }, ctx({ projectId: 'selftest-proj-A' }))
  check('★ 同项目里搜得到 project 作用域记忆', String(inSame).includes(String(p.item?.id)), String(inSame).slice(0, 80))

  const inOther = await tools.execute('memory_search', { query: 'zyzzyx-proj' }, ctx({ projectId: 'selftest-proj-B' }))
  check('★ 别的项目里搜不到（fail-closed，不串台）', !String(inOther).includes(String(p.item?.id)), String(inOther).slice(0, 80))

  const noProj = await tools.execute('memory_search', { query: 'zyzzyx-proj' }, ctx({ projectId: '' }))
  check('没项目上下文时也搜不到 project 记忆', !String(noProj).includes(String(p.item?.id)))

  group('memory_search / 只读：readonly 档照样能用')
  const ro = await tools.execute(
    'memory_search',
    { query: 'zyzzyx-alpha' },
    ctx({ permission: 'readonly' }),
  )
  check('★ readonly 权限下不被拦（证明它不走写操作那道门）', String(ro).includes('zyzzyx-alpha'), String(ro).slice(0, 60))

  group('memory_search / 指路文案（模型唯一读得到的入口提示）')
  const recallSrc = read('electron/core/memory-recall.cjs')
  check('★ 注入文案提到 memory_search', recallSrc.includes('memory_search'))
  check(
    '★ 旧的「去设置 → 记忆里看看」已经不再对模型说（那是指给「人」的，模型没有设置页）',
    !recallSrc.includes('设置 → 记忆里看看'),
  )

  group('memory-trigger / 纯函数命中判定（不调 LLM，只词表/正则）')
  const trigger = require(join(ROOT, 'electron/core/memory-trigger.cjs'))
  check(
    '★ 回溯词 + 疑问语气 → 命中',
    trigger.shouldPromptRecall('我们之前是不是约定过用 pnpm？') === true,
  )
  check('「你还记得上次那个 bug 吗」命中', trigger.shouldPromptRecall('你还记得上次那个 bug 吗') === true)
  check('★ 短句指涉旧事也命中（不必带问号）', trigger.shouldPromptRecall('之前说的那个') === true)
  check('「上次部署到哪了」命中', trigger.shouldPromptRecall('上次部署到哪了') === true)
  check('★ 普通新问题**不**命中（不误注入）', trigger.shouldPromptRecall('写个快排') === false)
  check('无关的短句不命中', trigger.shouldPromptRecall('帮我看看这个文件') === false)
  check(
    '★ 长正文（粘贴进来的那种）不命中 —— 别把文档当回忆',
    trigger.shouldPromptRecall('记得改一下这个函数名和那些调用它的地方，顺便把测试也补上，还有文档也要同步更新一下') ===
      false,
  )
  check('非字符串不炸', trigger.shouldPromptRecall(null) === false && trigger.shouldPromptRecall(undefined) === false)

  group('memory-trigger / 注入落点（易变区尾部，命中才加）')
  const recall = require(join(ROOT, 'electron/core/memory-recall.cjs'))
  const hitSection = recall.buildPromptSection({ query: '我们之前是不是约定过 zyzzyx-alpha？' })
  check('★ 命中时注入引导句', hitSection.includes('先调 memory_search 搜关键词确认'), hitSection.slice(-80))
  const missSection = recall.buildPromptSection({ query: '写个快排' })
  check('★ 不命中时一个字都不多加', !missSection.includes('像是在回忆之前的事'))
  check(
    '★ 引导句留在 memory-recall（relevantMemory 层 = 易变区），没混进 prompt-stack 的稳定层',
    read('electron/core/memory-recall.cjs').includes('像是在回忆之前的事') &&
      !read('electron/core/prompt-stack.cjs').includes('像是在回忆之前的事'),
  )
  check(
    '★ 提示词版本已升到 /9（CE-010 主动记忆检索之后）',
    promptStackCore.VERSION === 'prompt-stack/9',
    promptStackCore.VERSION,
  )

  for (const id of spill) memory.remove(id)
  check(
    '测试记忆已清理',
    memory.list({ includeSuperseded: true }).every((i) => !spill.includes(i.id)),
  )
}
