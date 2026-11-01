/**
 * 自检 / Codex CLI 接入稳定性：
 *       ⑨ 辅助任务不复用主任务后端（压缩 / 复核不能再拿空 baseUrl 去发请求）
 *       ⑩ 可选代理（默认空 = 逐字节沿用 `process.env`；不硬编码任何地址）
 *       ⑪ 可配置 CODEX_HOME（默认空 = 原样不动；**Harbor 绝不碰那个目录**）
 * 本组不联网、不起真 codex；所有检查均在 run 内、隔离环境初始化后执行。
 * ★ 三组都遵守同一条硬判据：**「默认」必须是不改变现有行为**。
 *   所以每组第一条都钉「没配 → `buildEnv` 返回的就是 `process.env` 本身」。
 */

import { readFileSync, mkdirSync, join, require, ROOT, paths } from '../env.mjs'
import { check, group } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')

/**
 * 剥掉注释再匹配 —— 否则「注释里提到了 `auth.json` / `codexHome`」会被误判成
 * 「代码碰了它」。写这组时第一次就这么**假红**了：判据命中的是我自己写的说明文字。
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 一个**不是本机真实代理**的样例 —— 用它才能证明「没有硬编码任何地址」 */
const PROXY_SAMPLE = 'http://127.0.0.1:9999'
const matchesOverrides = (env, overrides) => {
  const expected = { ...process.env, ...overrides }
  return Object.keys(env).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => env[key] === value)
}

export async function run() {
  const CLI = require(join(ROOT, 'electron/core/codex-cli.cjs'))
  const AUX = require(join(ROOT, 'electron/core/aux-model.cjs'))
  const K = require(join(ROOT, 'electron/core/provider-kinds.cjs'))
  const NP = require(join(ROOT, 'electron/core/config-normalize-parts.cjs'))

  /* ── ⑨ 辅助任务模型分离（压缩 / 复核不复用主任务那个 provider）── */
  /*
   * 真机病：主任务能选 codex-cli（baseUrl 空串），而压缩 / 复核调的是 llm.chatStream ——
   * 沿用主任务 provider 就必然拿空 baseUrl 发请求 → 必失败。这组的判据是
   * 「辅助活自己挑一个能走 HTTP 的后端」，而不是跟着主任务一起坏。
   */
  group('Codex 稳定性 · 辅助任务不复用主任务后端（压缩 / 复核）')
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
  check('★ 辅助判据只有一处（aux-model 不自己判 kind —— 硬约束 #9）', !/isCodexCli|kind === 'codex-cli'/.test(R('electron/core/aux-model.cjs')))

  /* ── ⑩ 可选代理（默认不改行为）── */
  group('Codex 稳定性 · 可选代理（默认空 = 逐字节沿用 process.env）')
  check('★★ 没配 proxy → buildEnv 返回的**就是** process.env（同一个引用）', CLI.buildEnv({}) === process.env)
  check('★ proxy 是空串 / 只有空白 → 一样（不注入空白值）', CLI.buildEnv({ proxy: '' }) === process.env && CLI.buildEnv({ proxy: '   ' }) === process.env)
  const envP = CLI.buildEnv({ proxy: PROXY_SAMPLE })
  check('★★ 配了 proxy → 只覆盖 HTTPS_PROXY / HTTP_PROXY，其余环境完整保留', matchesOverrides(envP, { HTTPS_PROXY: PROXY_SAMPLE, HTTP_PROXY: PROXY_SAMPLE }))
  check('★ 两个键都设成配置值（有些库只认 HTTP_PROXY）', envP.HTTPS_PROXY === PROXY_SAMPLE && envP.HTTP_PROXY === PROXY_SAMPLE)
  check('★ 是在副本上改（不污染本进程）', envP !== process.env && process.env.HTTPS_PROXY !== PROXY_SAMPLE)
  check('★ 前后空白被 trim', CLI.buildEnv({ proxy: `  ${PROXY_SAMPLE}  ` }).HTTPS_PROXY === PROXY_SAMPLE)
  check('★ 规范化层认这个字段（不写白名单会被静默丢掉）', NP.normalizeProvider({ id: 'c', kind: 'codex-cli', proxy: PROXY_SAMPLE }, 0).proxy === PROXY_SAMPLE)
  check('★ 老配置没有 proxy → 空串（默认值即兼容）', NP.normalizeProvider({ id: 'c', kind: 'codex-cli' }, 0).proxy === '')
  check('★ 非字符串 → 空串（不信任输入）', NP.normalizeProvider({ id: 'c', kind: 'codex-cli', proxy: 1 }, 0).proxy === '')
  check('★ 接线：适配器把 env 交给 runCodex', /env: buildEnv\(provider\)/.test(R('electron/core/codex-cli.cjs')))
  check('★★ 内核与界面都**没有硬编码本机代理地址**（10808 一个都不许出现）', !/10808/.test(R('electron/core/codex-cli.cjs')) && !/10808/.test(R('electron/core/config-codex-preset.cjs')) && !/10808/.test(R('src/components/settings/providers/CodexCliCard.tsx')))

  /* ── ⑪ 可配置 CODEX_HOME（默认空 = 原样不动；且绝不碰那个目录）── */
  group('Codex 稳定性 · CODEX_HOME（可选；Harbor 只设环境变量，绝不碰那个目录）')
  const HOME_PROBE = 'E:\\CodexWorkbench\\data\\unit-test-data\\codex-home-probe'
  check('★ 没配 → 仍是 process.env 本身（默认不改行为）', CLI.buildEnv({ codexHome: '' }) === process.env && CLI.buildEnv({ codexHome: '  ' }) === process.env)
  const envH = CLI.buildEnv({ codexHome: HOME_PROBE })
  check('★★ 配了 → 只覆盖 CODEX_HOME，其余键值全同', matchesOverrides(envH, { CODEX_HOME: HOME_PROBE }))
  check(
    '★ 与代理同上时三个键齐',
    matchesOverrides(CLI.buildEnv({ proxy: PROXY_SAMPLE, codexHome: HOME_PROBE }),
      { CODEX_HOME: HOME_PROBE, HTTP_PROXY: PROXY_SAMPLE, HTTPS_PROXY: PROXY_SAMPLE }),
  )
  /*
   * ★★ 这几条是**用户第 3 条**（不得自动复制/迁移/删除认证文件）的落地判据。
   * 只看**代码**（剥掉注释）—— 见文件头那条「第一次假红」的说明。
   */
  const codexCode = stripComments(`${R('electron/core/codex-cli.cjs')}\n${R('electron/core/codex-run.cjs')}`)
  check('★★ 代码里不出现 auth.json（凭据文件一个字节都不动）', !/auth\.json/.test(codexCode))
  check(
    '★★ 没有 mkdir / cp / rm / 读写 任何 codexHome 的代码',
    !/(mkdir|cpSync|copyFile|rmSync|unlink|rmdir|readFile|writeFile)[^\n]*codexHome/i.test(codexCode) &&
      !/codexHome[^\n]*(mkdir|cpSync|copyFile|rmSync|unlink|rmdir|readFile|writeFile)/i.test(codexCode),
  )
  check('★ codexHome 的唯一去处就是环境变量', /env\.CODEX_HOME\s*=\s*codexHome/.test(codexCode))
  check(
    '★ 规范化层认这个字段 / 老配置 → 空串 / 非字符串 → 空串',
    NP.normalizeProvider({ id: 'c', codexHome: HOME_PROBE }, 0).codexHome === HOME_PROBE &&
      NP.normalizeProvider({ id: 'c' }, 0).codexHome === '' &&
      NP.normalizeProvider({ id: 'c', codexHome: 7 }, 0).codexHome === '',
  )
  const presetSrc = require(join(ROOT, 'electron/core/config-codex-preset.cjs')).CODEX_CLI_PROVIDER
  check('★★ 预设里三个可选项都是空串（不替用户决定路径/代理/数据目录）', presetSrc.codexPath === '' && presetSrc.proxy === '' && presetSrc.codexHome === '')
  const cardSrc = R('src/components/settings/providers/CodexCliCard.tsx')
  check('★★ 卡片写明「改后要重新登录」', /重新登录/.test(cardSrc))
  check('★★ 卡片写明 Harbor 不复制 / 迁移 / 删除凭据', /复制、迁移或删除任何登录文件/.test(cardSrc))
  check('★ 卡片里没有 markdown 星号残留（JSX 会原样显示）', !/\*\*[^*]+\*\*/.test(stripComments(cardSrc)))
  /* 两个入口（内核预设 / 界面一键添加）造的对象形状要一致 —— 硬约束 #9 */
  const storeSrc = R('src/stores/useConfigStore.ts')
  check('★★ 界面「一键添加」入口也带这三个可选项（两个入口形状一致，且都留空）', /codexPath: ''/.test(storeSrc) && /proxy: ''/.test(storeSrc) && /codexHome: ''/.test(storeSrc))

  /*
   * ── ⑭ 三层结果语义（2026-10-17 修正）──
   *
   * 真机病：`read_file` 找不到文件时返回「错误：…」，桥照样回 `ok:true`，
   * 于是 MCP 向 Codex 报**成功**（`status=completed` + 一段错误文案）。
   * 用户第 1 条要求：**必须区分**通信成功 / 转发成功 / 工具执行成功。
   *
   * 这一组**真起桥 + 真跑 MCP server 协议层**（不是源级字符串检查）。
   * 数据根用 selftest 数据目录下的**独立子目录** —— 管道名由它 hash，不与任何东西撞。
   */
  group('Codex 桥 · 三层结果语义（通信 / 转发 / 工具 必须分得开）')
  const P = require(join(ROOT, 'electron/core/codex-mcp-policy.cjs'))
  check('★ "错误：…" 算工具失败', P.isToolFailure('错误：文件不存在') === true)
  check('★ "用户拒绝了…" 也算工具失败（index.cjs 那处分不清，这里分清）', P.isToolFailure('用户拒绝了这个操作：写文件') === true)
  check('正常正文不算失败', P.isToolFailure('POC-OK') === false && P.isToolFailure('') === false)

  const net = require('node:net')
  const fsx = require('node:fs')
  const pathx = require('node:path')
  const B = require(join(ROOT, 'electron/core/codex-mcp-protocol.cjs'))
  const { createBridge } = require(join(ROOT, 'electron/core/codex-mcp-bridge.cjs'))
  const DATA = join(ROOT, 'data', 'selftest-data', 'codex-mcp-semantics')
  const WSX = join(DATA, 'ws')
  fsx.rmSync(DATA, { recursive: true, force: true })
  fsx.mkdirSync(WSX, { recursive: true })
  fsx.writeFileSync(join(WSX, 'ok.txt'), 'Q4-OK\n', 'utf8')

  const bridge = createBridge({
    resolveWorkdir: () => WSX,
    dataDir: DATA,
    isoDir: DATA,
    log: { warn: () => {}, info: () => {} },
  })
  bridge.start()
  const TOKEN = B.readToken(DATA)

  /** 经真管道问一次（与 MCP server 同一条路） */
  const askOnce = (tool, args) =>
    new Promise((resolve) => {
      const sock = net.connect(B.pipeName(DATA))
      let buf = Buffer.alloc(0)
      sock.on('connect', () =>
        sock.write(B.encodeFrame(B.request({ id: 'st-1', kind: 'tool:call', payload: { tool, args }, token: TOKEN }))),
      )
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, /** @type {Buffer} */ (chunk)])
        const parsed = B.decodeFrames(buf)
        buf = parsed.rest
        if (parsed.messages.length) {
          sock.end()
          resolve(parsed.messages[0])
        }
      })
      setTimeout(() => resolve({ ok: false, error: { code: 'TIMEOUT' } }), 8000)
    })

  const bad = await askOnce('harbor_read_file', { path: 'definitely-missing-q4.txt' })
  check('★★ 工具失败时：转发层 ok=true，但**工具层 toolOk=false**（这条就是那次修正）', bad.ok === true && bad.payload?.toolOk === false, `ok=${bad.ok} toolOk=${bad.payload?.toolOk}`)
  const good = await askOnce('harbor_read_file', { path: 'ok.txt' })
  check('工具成功时：toolOk=true', good.ok === true && good.payload?.toolOk === true)
  const denied = await askOnce('harbor_read_file', { path: '../escape.txt' })
  check('★ 转发层拒绝时**没有** toolOk（那是第三种情况，别混）', denied.ok === false && denied.payload === undefined, denied.error?.code)
  bridge.stop()
  fsx.rmSync(DATA, { recursive: true, force: true })

  /* MCP 协议层：工具失败 → isError:true（用 spawn + 真管道；像真机那样保持 stdin 打开） */
  const { spawn: spawnx } = require('node:child_process')
  /* ★ 换一个子目录：桥 stop 之后管道释放是**异步**的，同一名字立刻再 listen 会 EADDRINUSE */
  const DATA2 = join(ROOT, 'data', 'selftest-data', 'codex-mcp-semantics2')
  const WSX2 = join(DATA2, 'ws')
  const mcpLayer = await new Promise((resolve) => {
    const bridge2 = createBridge({ resolveWorkdir: () => WSX2, dataDir: DATA2, isoDir: DATA2, log: { warn: () => {}, info: () => {} } })
    fsx.rmSync(DATA2, { recursive: true, force: true })
    fsx.mkdirSync(WSX2, { recursive: true })
    fsx.writeFileSync(join(WSX2, 'ok.txt'), 'Q4-OK\n', 'utf8')
    bridge2.start()
    const child = spawnx(process.execPath, [join(ROOT, 'electron/mcp-server-standalone.cjs'), DATA2], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const finish = (v) => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      bridge2.stop()
      resolve(v)
    }
    child.stdout.on('data', (c) => {
      out += c
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 2) finish(msg)
        } catch {
          /* 半行 */
        }
      }
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'harbor_read_file', arguments: { path: 'missing-q4.txt' } } })}\n`,
    )
    setTimeout(() => finish(null), 20000)
  })
  check('★★ MCP 层把工具失败翻成 isError:true（Codex 才不会以为成功了）', mcpLayer?.result?.isError === true, JSON.stringify(mcpLayer?.result ?? {}).slice(0, 90))
  check('★ 文案点名「Harbor 工具执行失败」', /Harbor 工具执行失败/.test(mcpLayer?.result?.content?.[0]?.text ?? ''))
  fsx.rmSync(DATA2, { recursive: true, force: true })

/* ── ⑩ 提示词里的「工具声明」三态（2026-10-17 真机修的矛盾）──
 *
 * 病：MCP 桥开着时，Codex **真有工具**，而 prompt 仍在说「本次没有可用的工具」——
 * 它于是有时信了那句、回「当前未提供 harbor_write_file MCP 工具」（写入验收时灵时不灵）。
 * 判据只有 `codex-msg.buildPrompt` 一处，所以这里直接喂假数据钉住三态。
 */
group('Codex 稳定性 · 提示词的工具声明（有 MCP 工具时不得再否认）')
const MSG = require(join(ROOT, 'electron/core/codex-msg.cjs'))
const LIFE = require(join(ROOT, 'electron/core/codex-mcp-lifecycle.cjs'))
const msgs = [{ role: 'user', content: '写个文件' }]
const withMcp = MSG.buildPrompt(msgs, { tools: [{}], mcpTools: ['harbor_read_file', 'harbor_write_file'] })
check('★ 有 MCP 工具 → **不再**写「没有可用的工具」那句', !/没有可用的工具/.test(withMcp))
check('★★ 有 MCP 工具 → 如实列出工具名', /harbor_write_file/.test(withMcp) && /harbor_read_file/.test(withMcp))
check('★★ 有 MCP 工具 → 说明写操作要先经用户确认', /弹给用户确认|用户可能同意也可能拒绝/.test(withMcp))
check('★ 有 MCP 工具 → 说明它自己没有 shell（沙箱只读）', /沙箱是只读的/.test(withMcp))
check('★ 没有 MCP 工具 + 有 tools → 仍是老的「没有工具」声明', /没有可用的工具/.test(MSG.buildPrompt(msgs, { tools: [{}] })))
check('★ 什么都没有 → 两句都不写', !/工具】/.test(MSG.buildPrompt(msgs, {})))

/* 桥的开关 → 暴露哪些工具（写没开就**不许**宣称有写工具） */
const saveEnv = { m: process.env.HARBOR_CODEX_MCP, w: process.env.HARBOR_CODEX_MCP_WRITE, r: process.env.HARBOR_CODEX_MCP_WRITE_ROOT }
delete process.env.HARBOR_CODEX_MCP
check('★ 桥未启用 → 暴露工具为空（不认识任何 MCP 工具）', LIFE.exposedToolNames().length === 0)
process.env.HARBOR_CODEX_MCP = '1'
check('★ 桥开了、写没开 → 只读文件、图片和分析工具可用', JSON.stringify(LIFE.exposedToolNames()) === JSON.stringify(['harbor_read_file', 'harbor_read_image', 'harbor_env_diag', 'harbor_analyze_test_failure']))
process.env.HARBOR_CODEX_MCP_WRITE = '1'
process.env.HARBOR_CODEX_MCP_WRITE_ROOT = 'E:\\CodexWorkbench\\data\\unit-test-data\\selftest-ws'
check('★★ 写也开了 → 三个工具（含写）', LIFE.exposedToolNames().includes('harbor_write_file'))
for (const [k, v] of [['HARBOR_CODEX_MCP', saveEnv.m], ['HARBOR_CODEX_MCP_WRITE', saveEnv.w], ['HARBOR_CODEX_MCP_WRITE_ROOT', saveEnv.r]]) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

/* ── ⑪ 设置段的形状与「关闭即生效」（2026-10-17 第四阶段）──
 *
 * 只在**配置层**钉，不重复 L4 那套（真机验证过了）。覆盖三个此前没有判据的风险：
 *   ① 默认值必须是全关（升级不能凭空多出一条能写文件的外部通道）
 *   ② 规范化只认 === true（"yes" / 1 这类真值不能把权限打开）
 *   ③ 写目录越界必须被**代码**拒（不是靠约定）
 */
group('Codex MCP 设置 · 默认全关 / 只认严格 true / 写目录越界必须拒')
const CM = require(join(ROOT, 'electron/core/config-codex-mcp.cjs'))
const PM = require(join(ROOT, 'electron/core/codex-mcp-policy.cjs'))
check(
  '★★ 默认值四项全关（enabled/write/writeRoot/runTest）',
  CM.CODEX_MCP_DEFAULTS.enabled === false && CM.CODEX_MCP_DEFAULTS.write === false && CM.CODEX_MCP_DEFAULTS.writeRoot === '' && CM.CODEX_MCP_DEFAULTS.runTest === false,
)
const junkMcp = CM.normalizeCodexMcp({ enabled: 'yes', write: 1, runTest: 'true', writeRoot: 42, evilKey: 'x' })
check(
  '★★ 只认 === true（"yes"/1/"true" 都不算开）+ 多余键被丢掉',
  junkMcp.enabled === false && junkMcp.write === false && junkMcp.runTest === false && !('evilKey' in junkMcp),
)
check('★ 缺字段 / 非对象 → 回落成全关', CM.normalizeCodexMcp(undefined).enabled === false && CM.normalizeCodexMcp(null).write === false)
const isoRoot = join(paths.DIRS.data, 'codex-mcp-settings')
mkdirSync(isoRoot, { recursive: true })
check('★★ 写根指向正式源码 → 被 policy 拒（代码判据）', PM.resolveWriteRoot(join(ROOT, 'electron'), isoRoot).ok === false)
check('★ 写根落在隔离数据根内 → 放行', PM.resolveWriteRoot(isoRoot, isoRoot).ok === true)
}
