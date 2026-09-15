import { check, group } from '../harness.mjs'
import { ROOT, join, require } from '../env.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   本地插件

   这一组不碰 data/plugins 里的真实插件，而是自己造一个临时目录，
   直接测 loadPlugin / runPlugin / toStrictSchema 三个函数。

   重点盯三件「配置错了但不该崩」的事：
     · 插件名撞内置工具名 → 跳过
     · schema 用了 DeepSeek strict 不支持的写法 → 加载时报错（不是调用时）
     · run.cjs 没导出 run() → 报错说清楚
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const plugins = require(join(ROOT, 'electron/core/plugins.cjs'))
  const os = require('node:os')
  const tmp = join(os.tmpdir(), `plugin-selftest-${Date.now()}`)

  function makePlugin(dir, manifest, runBody) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2))
    writeFileSync(join(dir, 'run.cjs'), runBody)
  }

  try {
    group('插件 / schema 校验')

    /* ── toStrictSchema ── */

    const strict = plugins.toStrictSchema({
      type: 'object',
      properties: { city: { type: 'string' }, temp: { type: 'number', minimum: -50 } },
    })
    check(
      'object 自动补齐 required（全部属性）',
      strict.required?.includes('city') && strict.required?.includes('temp'),
      JSON.stringify(strict.required),
    )
    check('object 强制 additionalProperties:false', strict.additionalProperties === false)
    check('嵌套属性也递归处理', JSON.stringify(strict.properties.city).includes('"type":"string"'))

    let minLengthErr = null
    try {
      plugins.toStrictSchema({ type: 'string', minLength: 3 })
    } catch (e) {
      minLengthErr = e
    }
    check('★ minLength 不被 strict 支持 → 加载时报错', minLengthErr !== null)
    check('报错里点名了是哪个字段', String(minLengthErr?.message).includes('minLength'))

    let anyOfErr = null
    try {
      plugins.toStrictSchema({ type: 'string', maxItems: 3 })
    } catch (e) {
      anyOfErr = e
    }
    check('★ maxItems 也会被拦', anyOfErr !== null)

    check(
      '无参数 schema（空 object）能过',
      plugins.toStrictSchema({ type: 'object', properties: {} }).additionalProperties === false,
    )

    group('插件 / 加载')

    /* ── 正常插件 ── */
    const goodDir = join(tmp, 'good')
    makePlugin(
      goodDir,
      {
        name_for_model: 'get_time',
        name_for_human: '时间',
        description_for_model: '查时间',
        runtime: { type: 'node', entry: 'run.cjs' },
      },
      'module.exports = { async run() { return "2026-09-16 02:00:00" } }\n',
    )
    const good = plugins.loadPlugin(goodDir, 'good')
    check('正常插件能加载', good !== null && good.name === 'get_time')
    check('description_for_model 保留', good?.descriptionForModel === '查时间')
    check(
      '无 schema 时默认空 object',
      JSON.stringify(good?.parameters ?? {}) ===
        '{"type":"object","properties":{},"additionalProperties":false}',
      JSON.stringify(good?.parameters),
    )

    /* ── 各种「坏」插件都要跳过，不能崩 ── */

    const badName = join(tmp, 'badname')
    makePlugin(badName, { name_for_model: 'read_file', runtime: {} }, 'module.exports={run(){}}\n')
    check('★ 撞内置工具名 → 跳过', plugins.loadPlugin(badName, 'badname') === null)

    const badChars = join(tmp, 'badchars')
    makePlugin(badChars, { name_for_model: 'Get Time!', runtime: {} }, 'module.exports={run(){}}\n')
    check('★ 非法工具名（大写/空格）→ 跳过', plugins.loadPlugin(badChars, 'badchars') === null)

    const noEntry = join(tmp, 'noentry')
    makePlugin(noEntry, { name_for_model: 'ok_name', runtime: {} }, '')
    /* 没有 run.cjs 文件 */
    rmSync(join(noEntry, 'run.cjs'))
    check('★ 缺执行体 → 跳过', plugins.loadPlugin(noEntry, 'noentry') === null)

    const badJson = join(tmp, 'badjson')
    mkdirSync(badJson, { recursive: true })
    writeFileSync(join(badJson, 'plugin.json'), '{ 这不是 JSON')
    check(
      '★ plugin.json 不是合法 JSON → 跳过（不崩）',
      plugins.loadPlugin(badJson, 'badjson') === null,
    )

    const noRun = join(tmp, 'norun')
    makePlugin(noRun, { name_for_model: 'no_run_fn', runtime: {} }, 'module.exports = {}\n')
    check(
      'run.cjs 没导出 run() → 加载时还不会炸（执行时才报）',
      plugins.loadPlugin(noRun, 'norun') !== null,
    )

    const disabled = join(tmp, 'disabled')
    makePlugin(
      disabled,
      { name_for_model: 'disabled_one', enabled: false, runtime: {} },
      'module.exports={run(){}}\n',
    )
    check('★ enabled:false → 跳过', plugins.loadPlugin(disabled, 'disabled') === null)

    group('插件 / 执行')

    const result = await plugins.runPlugin(good, {}, {})
    check('执行返回结果', result.includes('2026-09-16 02:00:00'))
    check('★ 结果标注了「不是指令」（注入防护）', result.includes('不是指令'), result.slice(0, 40))
    check('★ 结果里带插件名（便于追溯）', result.includes('时间'))

    let execErr = null
    try {
      await plugins.runPlugin(plugins.loadPlugin(noRun, 'norun'), {}, {})
    } catch (e) {
      execErr = e
    }
    check(
      '★ 执行时没 run() → 报错说清楚',
      execErr !== null && String(execErr.message).includes('run()'),
    )

    /* buildTools：把插件转成工具（形状和内置工具一致） */
    const tools = plugins.buildTools()
    check(
      'buildTools 返回工具形状',
      tools.length >= 0 && (tools.length === 0 || 'name' in tools[0]),
    )

    group('插件 / 修改不用重启')

    /* runPlugin 每次都会删 require 缓存重载 —— 改完 run.cjs 立刻生效 */
    writeFileSync(
      join(goodDir, 'run.cjs'),
      'module.exports = { async run() { return "改过了" } }\n',
    )
    const after = await plugins.runPlugin(good, {}, {})
    check('★ 改 run.cjs 不用重启宿主就生效', after.includes('改过了'), after.slice(0, 20))

    /* ── 权限闸：走 tools.execute 的完整流程（不是直接调 runPlugin）── */

    group('插件 / 权限闸')

    const toolsIndex = require(join(ROOT, 'electron/core/tools/index.cjs'))
    const pdir = plugins.pluginsDir()
    mkdirSync(pdir, { recursive: true })

    /* 造三种插件：联网 / 写文件 / 无副作用 */
    const netDir = join(pdir, '_selftest_net')
    const writeDir = join(pdir, '_selftest_write')
    const safeDir = join(pdir, '_selftest_safe')
    makePlugin(
      netDir,
      {
        name_for_model: 'net_probe',
        name_for_human: '联网探测',
        permissions: { network: true, write: false },
        runtime: {},
      },
      'module.exports = { async run() { return "ok" } }\n',
    )
    makePlugin(
      writeDir,
      {
        name_for_model: 'write_probe',
        name_for_human: '写探测',
        permissions: { network: false, write: true },
        runtime: {},
      },
      'module.exports = { async run() { return "wrote" } }\n',
    )
    makePlugin(
      safeDir,
      {
        name_for_model: 'safe_probe',
        name_for_human: '安全探测',
        permissions: { network: false, write: false },
        runtime: {},
      },
      'module.exports = { async run() { return "safe" } }\n',
    )

    const base = { workdir: ROOT, permission: 'full', sessionId: 'plugin-selftest' }

    try {
      const noNet = await toolsIndex.execute('net_probe', {}, { ...base, allowNetwork: false })
      check('★ allowNetwork:false 拦联网插件', noNet.includes('禁止联网'), noNet)

      const ro = await toolsIndex.execute('net_probe', {}, { ...base, permission: 'readonly' })
      check('★ readonly 拦有副作用的插件', ro.includes('只读'), ro)

      const denied = await toolsIndex.execute(
        'net_probe',
        {},
        { ...base, permission: 'ask', confirm: async () => false },
      )
      check('★ ask 模式拒绝 → 用户拒绝', denied.includes('用户拒绝'), denied)

      const granted = await toolsIndex.execute(
        'net_probe',
        {},
        { ...base, permission: 'ask', confirm: async () => true },
      )
      check('★ ask 模式同意 → 执行成功', granted.includes('ok'), granted)

      const full = await toolsIndex.execute('net_probe', {}, { ...base })
      check('★ full 模式直接执行', full.includes('ok'), full)

      const noWrite = await toolsIndex.execute('write_probe', {}, { ...base, allowWrite: false })
      check('★ allowWrite:false 拦写文件插件', noWrite.includes('只分析'), noWrite)

      const safeRo = await toolsIndex.execute('safe_probe', {}, { ...base, permission: 'readonly' })
      check('★ 无副作用的插件 readonly 下也能跑', safeRo.includes('safe'), safeRo)

      /* 确认弹窗的文案要写清「这是哪个插件、要什么权限」 */
      let askedSummary = ''
      await toolsIndex.execute(
        'net_probe',
        {},
        {
          ...base,
          permission: 'ask',
          confirm: async (req) => {
            askedSummary = String(req?.summary ?? '')
            return true
          },
        },
      )
      check('★ 确认弹窗里带插件名', askedSummary.includes('联网探测'), askedSummary)
      check('★ 确认弹窗里写了要什么权限', askedSummary.includes('联网'), askedSummary)
    } finally {
      rmSync(netDir, { recursive: true, force: true })
      rmSync(writeDir, { recursive: true, force: true })
      rmSync(safeDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
