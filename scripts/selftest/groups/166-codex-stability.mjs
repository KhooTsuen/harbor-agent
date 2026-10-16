/**
 * 自检 / Codex CLI 后端 —— **接入稳定性修复**（2026-10-17）
 *
 * 从 `165-codex-adapter.mjs` 拆出来的（那边加完这三组贴 300 行了）。分工：
 *   · **165** 管「适配器本体」—— 契约同形 / JSONL / 事件归约 / prompt / 进程层 /
 *     取消超时 / 配置兼容 / 能力声明 / 接线 / 行数
 *   · **166（本文件）** 管「后来发现的三个稳定性问题」：
 *       ⑨ 辅助任务不复用主任务后端（压缩 / 复核不能再拿空 baseUrl 去发请求）
 *       ⑩ 可选代理（默认空 = 逐字节沿用 `process.env`；不硬编码任何地址）
 *       ⑪ 可配置 CODEX_HOME（默认空 = 原样不动；**Harbor 绝不碰那个目录**）
 *
 * ⚠️ 本组**不联网、不起真 codex**（只跑纯函数与假 provider）。
 *
 * ★ 三组都遵守同一条硬判据：**「默认」必须是不改变现有行为**。
 *   所以每组第一条都钉「没配 → `buildEnv` 返回的就是 `process.env` 本身」。
 */

import { readFileSync, join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')

/**
 * 剥掉注释再匹配 —— 否则「注释里提到了 `auth.json` / `codexHome`」会被误判成
 * 「代码碰了它」。写这组时第一次就这么**假红**了：判据命中的是我自己写的说明文字。
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 一个**不是本机真实代理**的样例 —— 用它才能证明「没有硬编码任何地址」 */
const PROXY_SAMPLE = 'http://127.0.0.1:9999'

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
  check('★ 接线：reviewWithEvents 把 aux.provider 交给 selfReview', /provider: aux\.provider/.test(R('electron/core/loop-model.cjs')))
  check('★ 辅助判据只有一处（aux-model 不自己判 kind —— 硬约束 #9）', !/isCodexCli|kind === 'codex-cli'/.test(R('electron/core/aux-model.cjs')))

  /* ── ⑩ 可选代理（默认不改行为）── */
  group('Codex 稳定性 · 可选代理（默认空 = 逐字节沿用 process.env）')
  check('★★ 没配 proxy → buildEnv 返回的**就是** process.env（同一个引用）', CLI.buildEnv({}) === process.env)
  check('★ proxy 是空串 / 只有空白 → 一样（不注入空白值）', CLI.buildEnv({ proxy: '' }) === process.env && CLI.buildEnv({ proxy: '   ' }) === process.env)
  const envP = CLI.buildEnv({ proxy: PROXY_SAMPLE })
  const extraKeys = Object.keys(envP).filter((k) => !(k in process.env))
  check('★★ 配了 proxy → 只多 HTTPS_PROXY / HTTP_PROXY 两个键', extraKeys.length === 2 && extraKeys.every((k) => /^(HTTPS|HTTP)_PROXY$/.test(k)), JSON.stringify(extraKeys))
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
  const extraH = Object.keys(envH).filter((k) => !(k in process.env))
  check('★★ 配了 → 只多 CODEX_HOME 一个键，其余键值全同', extraH.length === 1 && extraH[0] === 'CODEX_HOME' && envH.CODEX_HOME === HOME_PROBE, JSON.stringify(extraH))
  check(
    '★ 与代理同上时三个键齐',
    JSON.stringify(Object.keys(CLI.buildEnv({ proxy: PROXY_SAMPLE, codexHome: HOME_PROBE })).filter((k) => !(k in process.env)).sort()) ===
      JSON.stringify(['CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY'].sort()),
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
}
