/**
 * 自检 / 基础：路径 / 配置 / 会话文件 / 各工具的读写执行
 *
 * 从 scripts/selftest.mjs 拆出来的（那边 1193 行了）。
 * 每个文件导出 `run()`，由 selftest.mjs 按顺序调用 —— 组之间**不共享状态**，
 * 所以加新组只要在 selftest.mjs 的清单里加一行。
 */

import { check, group } from '../harness.mjs'
import {
  ctx,
  asked,
  SANDBOX,
  configModule,
  existsSync,
  join,
  paths,
  readFileSync,
  session,
  setupSandbox,
  tools,
  writeFileSync,
} from '../env.mjs'

export async function run() {
  group('路径')
  const audits = paths.auditNonC()
  check(
    '数据目录不在 C 盘',
    audits.every((a) => a.ok),
    audits
      .filter((a) => !a.ok)
      .map((a) => a.dir)
      .join(', '),
  )
  check('DIRS 全部有值', Boolean(paths.DIRS.data && paths.DIRS.sessions && paths.DIRS.workspace))
  const dirs = paths.ensureDirs()
  check(
    'ensureDirs 建出了目录',
    dirs.every((d) => existsSync(d)),
  )

  /* ── 配置 ── */

  group('配置')
  const defaults = configModule.normalize(null)
  check('默认主题是 default', defaults.general.theme === 'default')
  check('玻璃拟态默认关', defaults.general.glassmorphism === false)
  check('默认权限是 ask', defaults.tools.permission === 'ask')
  check('默认有一个供应商', defaults.providers.length === 1)

  const dirty = configModule.normalize({
    general: { theme: '不存在的主题', fontScale: 9999, glassmorphism: 'yes' },
    tools: { permission: '乱写的', shellTimeout: -5 },
    providers: [],
  })
  check('脏主题被纠正成 default', dirty.general.theme === 'default', dirty.general.theme)
  check('字号被夹取到 150', dirty.general.fontScale === 150, String(dirty.general.fontScale))
  check('glassmorphism 只认 true', dirty.general.glassmorphism === false)
  check('脏权限被纠正', dirty.tools.permission === 'ask')
  check('超时被夹取到 5', dirty.tools.shellTimeout === 5, String(dirty.tools.shellTimeout))
  check('空供应商列表被补回默认', dirty.providers.length === 1)

  const saved = configModule.save({ ...defaults, general: { ...defaults.general, fontScale: 123 } })
  check('保存后立即生效', configModule.get().general.fontScale === 123)
  const rendered = configModule.forRenderer()
  check(
    'forRenderer 藏了 key',
    rendered.providers.every((p) => !p.apiKey.includes('sk-')),
  )
  configModule.save(saved) // 还原

  /* ── 会话 ── */

  group('会话存储')
  const created = session.create({ title: '单元测试会话', mode: 'execute', model: 'test-model' })
  check('create 返回 id', typeof created.id === 'string' && created.id.startsWith('sess_'))
  check('会话文件落盘了', existsSync(session.fileFor(created.id)))

  session.append(created.id, { role: 'user', content: '第一句', ts: Date.now() })
  session.append(created.id, { role: 'assistant', content: '第二句', ts: Date.now() })

  const loaded = session.load(created.id)
  check('load 拿得到 meta', loaded?.meta.title === '单元测试会话')
  check('load 拿得到 2 条消息', loaded?.messages.length === 2, String(loaded?.messages.length))

  const listed = session.list()
  const mine = listed.find((s) => s.id === created.id)
  check('list 里能找到', Boolean(mine))
  check('list 统计了消息数', mine?.messageCount === 2, String(mine?.messageCount))

  session.updateMeta(created.id, { title: '改过的标题' })
  check('改标题生效', session.load(created.id)?.meta.title === '改过的标题')

  const apiMessages = session.toApiMessages(created.id, 10)
  check(
    'toApiMessages 只给 user/assistant',
    apiMessages.every((m) => m.role === 'user' || m.role === 'assistant'),
  )
  check('toApiMessages 带上了内容', apiMessages[0]?.content === '第一句')

  session.append(created.id, { role: 'tool', content: '工具输出不该进 messages' })
  const afterTool = session.toApiMessages(created.id, 10)
  check('tool 消息被过滤掉', afterTool.length === 2, String(afterTool.length))

  /*
   * 工具记录重放时，分隔符必须是**真换行**。
   *
   * 踩过：源码里写成 `\\n`（两个反斜杠）或真换行（模板里当续行符），
   * 两边都会把换行吃掉，而 `node --check` / tsc 都看不出问题，
   * 模型收到的是 `好了\n\n[此前工具执行记录]` 这种一行字面量。
   */
  const replayThread = session.create({ title: '重放', mode: 'pair' })
  session.append(replayThread.id, { role: 'user', content: '跑命令' })
  session.append(replayThread.id, {
    role: 'assistant',
    content: '好了',
    toolRuns: [{ name: 'run_shell', ok: true, output: 'l1\nl2' }],
  })
  const replay = session.toApiMessages(replayThread.id, 10).at(-1)?.content ?? ''
  check('工具记录重放用的是真换行', replay.includes('[此前工具执行记录]\n'), JSON.stringify(replay))
  check('工具记录里没有字面量反斜杠 n', !replay.includes('\\n'))
  session.remove(replayThread.id)

  /* 超长标题会被截断 */
  const longTitle = session.create({ title: 'x'.repeat(200) })
  check(
    '超长标题被截断',
    session.load(longTitle.id)?.meta.title.length <= 60,
    String(session.load(longTitle.id)?.meta.title.length),
  )

  session.remove(created.id)
  session.remove(longTitle.id)
  check('删除后文件没了', !existsSync(session.fileFor(created.id)))

  /* ── 工具：读 ── */

  group('工具 / read_file')
  setupSandbox()
  /*
   * 确认回调：真实环境里它会弹给用户，自检里一律批准。
   * 顺便把「被问了什么」记下来 —— 有些测试要靠它断言「确实问过」。
   */
  /* ctx / asked 是跨组共享的固定件，在 env.mjs 里 */

  const readResult = await tools.execute('read_file', { path: 'hello.txt' }, ctx)
  check('读到了内容', readResult.includes('line two'))
  check('带了行号', /^\s*1\| line one/m.test(readResult), readResult.slice(0, 60))

  const ranged = await tools.execute('read_file', { path: 'hello.txt', offset: 2, limit: 1 }, ctx)
  check('offset/limit 生效', ranged.includes('line two') && !ranged.includes('line three'))

  const missing = await tools.execute('read_file', { path: '不存在.txt' }, ctx)
  check('读不存在的文件返回错误文本', missing.startsWith('错误：'), missing.slice(0, 50))

  /* ── 工具：列目录 ── */

  group('工具 / list_dir')
  const listing = await tools.execute('list_dir', { path: '.' }, ctx)
  check('列出了文件', listing.includes('hello.txt') && listing.includes('dup.txt'))

  /* ── 工具：写 ── */

  group('工具 / write_file')
  const writeResult = await tools.execute(
    'write_file',
    { path: 'sub/new.txt', content: '新建的内容' },
    ctx,
  )
  check('新建成功', writeResult.includes('新建'))
  check('父目录被自动创建', existsSync(join(SANDBOX, 'sub', 'new.txt')))

  const overwrite = await tools.execute('write_file', { path: 'hello.txt', content: '覆盖了' }, ctx)
  check('覆盖已有文件', overwrite.includes('覆盖'))
  check('内容真的变了', readFileSync(join(SANDBOX, 'hello.txt'), 'utf8') === '覆盖了')

  writeFileSync(join(SANDBOX, 'hello.txt'), 'line one\nline two\nline three\n', 'utf8')

  /* ── 工具：改 ── */

  group('工具 / edit_file')
  const editOk = await tools.execute(
    'edit_file',
    { path: 'hello.txt', oldText: 'line two', newText: '第二行' },
    ctx,
  )
  check('唯一匹配时替换成功', editOk.includes('已修改'), editOk.slice(0, 60))
  check('替换结果正确', readFileSync(join(SANDBOX, 'hello.txt'), 'utf8').includes('第二行'))

  const notFound = await tools.execute(
    'edit_file',
    { path: 'hello.txt', oldText: '根本不存在的内容', newText: 'x' },
    ctx,
  )
  check('找不到原文时报错', notFound.startsWith('错误：') && notFound.includes('找不到'))

  const ambiguous = await tools.execute(
    'edit_file',
    { path: 'dup.txt', oldText: 'same', newText: 'changed' },
    ctx,
  )
  /* dup.txt 里 same 只出现一次，所以应该成功 */
  check('出现一次就能改', ambiguous.includes('已修改'))

  writeFileSync(join(SANDBOX, 'dup2.txt'), 'aaa\naaa\n', 'utf8')
  const twice = await tools.execute(
    'edit_file',
    { path: 'dup2.txt', oldText: 'aaa', newText: 'bbb' },
    ctx,
  )
  check(
    '出现多次时拒绝执行',
    twice.startsWith('错误：') && twice.includes('多次'),
    twice.slice(0, 80),
  )

  /* ── 工具：命令 ── */

  group('工具 / run_shell')
  const echo = await tools.execute('run_shell', { command: 'echo hello-selftest' }, ctx)
  check('命令有输出', echo.includes('hello-selftest'), echo.slice(0, 80))
  check('带了退出码', echo.includes('退出码'))

  const danger = await tools.execute('run_shell', { command: 'rm -rf /' }, ctx)
  check(
    '危险命令被拦下',
    danger.startsWith('错误：') && danger.includes('破坏系统'),
    danger.slice(0, 60),
  )

  const badCmd = await tools.execute('run_shell', { command: 'definitely-not-a-command-xyz' }, ctx)
  check('不存在的命令返回非零退出码', badCmd.includes('退出码'), badCmd.slice(0, 80))

  /* ── 权限 ── */

  group('权限控制')
  const readOnlyCtx = { ...ctx, permission: 'readonly' }
  const blocked = await tools.execute('write_file', { path: 'x.txt', content: 'nope' }, readOnlyCtx)
  check('只读模式拦下写操作', blocked.includes('只读'), blocked.slice(0, 60))

  const readAllowed = await tools.execute('read_file', { path: 'hello.txt' }, readOnlyCtx)
  check('只读模式仍能读', readAllowed.includes('第二行'))

  const askDenied = await tools.execute(
    'write_file',
    { path: 'denied.txt', content: 'nope' },
    { ...ctx, permission: 'ask', confirm: async () => false },
  )
  check('ask 模式被拒绝时不执行', askDenied.includes('用户拒绝'), askDenied.slice(0, 60))
  check('确实没写出去', !existsSync(join(SANDBOX, 'denied.txt')))

  const askAllowed = await tools.execute(
    'write_file',
    { path: 'allowed.txt', content: 'ok' },
    { ...ctx, permission: 'ask', confirm: async () => true },
  )
  check('ask 模式同意后执行', askAllowed.includes('新建'))
  check('文件确实写出来了', existsSync(join(SANDBOX, 'allowed.txt')))

  /* ── 工具清单 ── */

  group('工具清单')
  const schema = tools.toApiSchema()
  check(
    '本地工具 5 个（不含后加的 search_web / remember）',
    schema.length >= 5,
    String(schema.length),
  )
  check(
    '每个都有 parameters',
    schema.every((t) => t.function.parameters?.type === 'object'),
  )
  check('写类工具被标记', tools.WRITE_TOOLS.has('write_file') && tools.WRITE_TOOLS.has('run_shell'))
  check('读类工具不被标记', !tools.WRITE_TOOLS.has('read_file'))

  /* ── 技能 ── */
}
