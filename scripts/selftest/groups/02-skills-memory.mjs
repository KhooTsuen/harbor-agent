/**
 * 自检 / 技能、记忆、搜索、统计、备份
 *
 * 从 scripts/selftest.mjs 拆出来的（那边 1193 行了）。
 * 每个文件导出 `run()`，由 selftest.mjs 按顺序调用 —— 组之间**不共享状态**，
 * 所以加新组只要在 selftest.mjs 的清单里加一行。
 */

import { check, group } from '../harness.mjs'
import {
  ROOT,
  backupCore,
  dirname,
  existsSync,
  readFileSync,
  fsCore,
  join,
  memory,
  mkdirSync,
  require,
  rmSync,
  searchCore,
  skills,
  statsCore,
  tools,
  writeFileSync,
} from '../env.mjs'

export async function run() {
  group('技能系统')
  check('ensureDir 建出目录', existsSync(skills.ensureDir()))

  /* 用 join 拼换行，避免字符串转义在多层传递中被吃掉 */
  const fm = (...lines) => lines.join(String.fromCharCode(10))

  const parsed = skills.parseFrontmatter(
    fm('---', 'name: 测试技能', 'description: 什么时候用它', '---', '', '正文'),
  )
  check('解析出 name', parsed.fields.name === '测试技能', String(parsed.fields.name))
  check('解析出 description', parsed.fields.description === '什么时候用它')
  check('正文不含 frontmatter', !parsed.body.includes('name:'))

  const quoted = skills.parseFrontmatter(fm('---', 'name: "带引号"', '---', '正文'))
  check('去掉外层引号', quoted.fields.name === '带引号', String(quoted.fields.name))

  const noFm = skills.parseFrontmatter('没有 frontmatter 的正文')
  check(
    '没有 frontmatter 时不崩',
    Object.keys(noFm.fields).length === 0 && noFm.body.includes('没有'),
  )

  const createdSkill = skills.create('自检技能-临时', '当单元测试跑到这里时用')
  check('create 返回 ok', createdSkill.ok === true, createdSkill.error ?? '')
  check('技能文件已写出', createdSkill.path ? existsSync(createdSkill.path) : false)

  const afterCreate = skills.list()
  check(
    'list 能看到新建的技能',
    afterCreate.some((x) => x.id === createdSkill.id),
  )

  const section = skills.buildPromptSection(afterCreate)
  check('提示词段包含技能名', section.includes('unit') || section.includes('自检技能'))
  check('提示词段包含路径', section.includes('SKILL.md'))
  check('空列表时提示词段为空串', skills.buildPromptSection([]) === '')

  const emptySkill = {
    id: 'x',
    name: 'x',
    description: 'x',
    bodyLength: 0,
    path: '',
    dir: '',
    updatedAt: 0,
  }
  check('空壳技能不进提示词', skills.buildPromptSection([emptySkill]) === '')

  skills.remove(createdSkill.id)
  check('remove 后列表里没了', !skills.list().some((x) => x.id === createdSkill.id))

  /* ── 压缩估算 ── */

  group('上下文压缩估算')
  const compact = require(join(ROOT, 'electron/core/compact.cjs'))
  check(
    'token 估算是字符数除以 3',
    compact.estimateTokens('abcdef') === 2,
    String(compact.estimateTokens('abcdef')),
  )
  check('空文本估 0', compact.estimateTokens('') === 0)

  const tiny = [{ role: 'user', content: '你好' }]
  check('短对话不需要压缩', compact.shouldCompact(tiny, 4096).needed === false)

  const huge = [{ role: 'user', content: 'x'.repeat(30000) }]
  check('长对话需要压缩', compact.shouldCompact(huge, 4096).needed === true)

  /* ── 记忆 ── */

  group('记忆系统（结构化）')
  const memoryBackup = memory.read()
  memory.clear()
  check('清空后读出来是空', memory.read() === '')
  check('空记忆不进提示词', memory.buildPromptSection() === '')

  const added = memory.add({
    content: '用户喜欢简短回复',
    type: 'preference',
    scope: 'global',
    source: 'user_explicit',
  })
  check('能加一条结构化记忆', added.ok === true && Boolean(added.item?.id))
  check(
    '类型和来源被记下',
    added.item.type === 'preference' && added.item.source === 'user_explicit',
  )
  check('明说的置信度是 1', added.item.confidence === 1)

  const dup = memory.add({ content: '用户喜欢简短回复', type: 'preference' })
  check('重复内容不重复写', dup.deduped === true, JSON.stringify(dup.item?.id))
  check('去重后只有一条', memory.list({ status: 'active' }).length === 1)

  const injected = memory.buildPromptSection({ query: '帮我写邮件' })
  check('提示词带上记忆内容', injected.includes('用户喜欢简短回复'))
  check('提示词标了类型', injected.includes('偏好'))

  /* 冲突：同一类型 + 高相似 → 旧的标 superseded，只注入新的 */
  memory.add({ content: '用户喜欢简短回复，不要长篇', type: 'preference', source: 'user_explicit' })
  const actives = memory.list({ status: 'active' })
  check(
    '冲突时新条目生效',
    actives.some((i) => i.content.includes('不要长篇')),
  )
  check(
    '被取代的条目还留着（可追溯）',
    memory.list({ includeSuperseded: true }).length > actives.length,
  )

  /* 密钥不许进记忆 —— 记忆每轮都注入，混一个 key 等于每轮都在泄露 */
  const secretAttempt = memory.add({ content: '我的 key 是 sk-abcdefghijklmnopqrstuvwxyz' })
  check('含密钥的内容被拒绝', secretAttempt.ok === false, JSON.stringify(secretAttempt.error))

  /* 检索：不相关的记忆不该被塞进提示词 */
  for (let i = 0; i < 30; i += 1) {
    memory.add({ content: `项目 A 的第 ${i} 条无关事实`, type: 'fact', scope: 'global' })
  }
  const limited = memory.retrieve({ query: '用户喜欢什么回复风格', limit: 5 })
  check('检索会限制条数', limited.length === 5, String(limited.length))
  check(
    '最相关的排在最前',
    limited[0].content.includes('简短') || limited[0].content.includes('回复'),
  )

  /*
   * 注入只该动 lastUsedAt，不该动 updatedAt。
   *
   * 以前这里是 `update(id, {})` —— updatedAt 被顶到现在，界面上的
   * 「最近更新」显示的其实是「最近被注入」。这条断言就是防它回退。
   */
  const probe = memory.list({ status: 'active' })[0]
  const beforeUpdated = probe.updatedAt
  memory.buildPromptSection({ query: '随便问点什么' })
  const after = memory.list({ includeSuperseded: true }).find((i) => i.id === probe.id)
  check('注入后 lastUsedAt 被记上', after.lastUsedAt > 0, String(after.lastUsedAt))
  check('注入不会假装改过内容（updatedAt 不动）', after.updatedAt === beforeUpdated)

  /* 停用 / 删除 */
  const toDisable = memory.list({ status: 'active' })[0]
  memory.disable(toDisable.id)
  check(
    '停用后不再是 active',
    !memory.list({ status: 'active' }).some((i) => i.id === toDisable.id),
  )
  memory.enable(toDisable.id)
  check(
    '能重新启用',
    memory.list({ status: 'active' }).some((i) => i.id === toDisable.id),
  )
  memory.remove(toDisable.id)
  check('能删除', !memory.list({ includeSuperseded: true }).some((i) => i.id === toDisable.id))

  check('统计能给出类型分布', typeof memory.stats().byType === 'object')
  check('统计能给出条数上限', memory.stats().maxItems > 0)

  memory.clear()
  memory.write(memoryBackup)
  check('记忆已还原', memory.read().trim() === memoryBackup.trim(), memory.read().slice(0, 60))

  /* ── 搜索 ── */

  group('联网搜索')
  const providerIds = searchCore.providerList().map((p) => p.id)
  check('有 4 个搜索后端', providerIds.length === 4, providerIds.join(', '))
  check('默认包含 duckduckgo', providerIds.includes('duckduckgo'))
  check(
    'tavily 需要 key',
    searchCore.providerList().find((p) => p.id === 'tavily')?.needKey === true,
  )

  const formatted = searchCore.formatResults('测试词', [
    { title: '结果一', url: 'https://a.com', snippet: '摘要一' },
  ])
  check('格式化带标题', formatted.includes('结果一'))
  check('格式化带 URL', formatted.includes('https://a.com'))
  check('空结果有提示', searchCore.formatResults('x', []).includes('没有结果'))

  await (async () => {
    let threw = false
    try {
      await searchCore.search('  ', {})
    } catch {
      threw = true
    }
    check('空搜索词被拒', threw)
  })()

  /* ── 工具清单（含新工具）── */

  group('工具清单（扩展后）')
  const schema2 = tools.toApiSchema()
  check('共 8 个工具（含 browse）', schema2.length === 8, String(schema2.length))
  check(
    '含 search_web',
    schema2.some((t) => t.function.name === 'search_web'),
  )
  check(
    '含 remember',
    schema2.some((t) => t.function.name === 'remember'),
  )
  check('remember 算写操作', tools.WRITE_TOOLS.has('remember'))
  check('isMcpTool 认得出前缀', tools.isMcpTool('mcp__fs__read') === true)
  check('isMcpTool 不认本地工具', tools.isMcpTool('read_file') === false)

  /* ── MCP ── */

  group('MCP 客户端')
  const mcpCore = require(join(ROOT, 'electron/core/mcp.cjs'))
  check('初始没有连接', Array.isArray(mcpCore.status()))
  check('没有服务器时工具列表为空', mcpCore.listTools().length === 0)
  const notMcp = await mcpCore.callTool('read_file', {})
  check('非 MCP 工具名返回 null', notMcp === null)

  /* ── 用量统计 ── */

  group('用量统计')
  const statsBackup = statsCore.load()
  statsCore.reset()
  check('清空后总量是 0', statsCore.summary().total.total === 0)
  check('没有 usage 时不记', statsCore.record(null, 'x').ok === false)
  check('usage 全 0 时不记', statsCore.record({ prompt_tokens: 0 }, 'x').ok === false)

  statsCore.record({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, 'model-a')
  statsCore.record({ prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 }, 'model-a')
  statsCore.record({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, 'model-b')

  const sum1 = statsCore.summary()
  check('总量累加正确', sum1.total.total === 445, String(sum1.total.total))
  check('输入累加正确', sum1.total.prompt === 310, String(sum1.total.prompt))
  check('输出累加正确', sum1.total.completion === 135, String(sum1.total.completion))
  check('调用次数累加', sum1.total.calls === 3, String(sum1.total.calls))
  check('按模型分成 2 组', sum1.models.length === 2, String(sum1.models.length))
  check('按模型降序（多的在前）', sum1.models[0].model === 'model-a', sum1.models[0].model)
  check('按天有 1 条', sum1.days.length === 1, String(sum1.days.length))
  check(
    '没给 total_tokens 也能算',
    (() => {
      statsCore.reset()
      statsCore.record({ prompt_tokens: 7, completion_tokens: 3 }, 'm')
      return statsCore.summary().total.total === 10
    })(),
  )

  statsCore.reset()
  check('清空后回到 0', statsCore.summary().total.calls === 0)
  /* 还原真实统计 */
  fsCore.mkdirSync(require('node:path').dirname(statsCore.statsFile()), { recursive: true })
  fsCore.writeFileSync(statsCore.statsFile(), JSON.stringify(statsBackup, null, 2), 'utf8')
}
