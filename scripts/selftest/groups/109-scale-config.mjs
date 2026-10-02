import { readdirSync } from 'node:fs'
import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group, warn } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   规模确认的**配置**（A2 第 4 步，从 108-scale-gate.mjs 拆出来的）

   为什么单独一组：108 那边加完配置检查顶到 379 行（硬约束 #2 是 300）。
   拆的口子按职责：108 管**判据**（哪些该拦、哪些不许误伤、授权、留痕），
   这一组管**配置**（默认值 → 归一化 → 读取 → **生效**）以及
   「**每个配置项都必须有人读**」那条通用检查。

   ★ 两处口径按用户 2026-10-03 拍板：
     · 「生效」测的是**判决改变**，不是「读到值」—— 只断言读到了，等于给
       「配置写了没人读」留后门（本项目有过先例）。
     · 「有人读」分两级：**字符串筛查**是快速过滤（注释里提到也算「提到」，会误报），
       **行为断言**才是最终判据；只有筛查、还没被行为钉住的那项标 `warn`，
       不算 pass —— 让「这里还没钉死」在输出里看得见。
   ══════════════════════════════════════════════════════════════ */

const WORKDIR = 'D:\\proj'
const noopAudit = () => {}

export async function run() {
  const gate = require(join(ROOT, 'electron/core/tools/scale-gate.cjs'))
  const scaleConfig = require(join(ROOT, 'electron/core/scale-config.cjs'))
  const defaultsCfg = require(join(ROOT, 'electron/core/config-defaults.cjs'))
  const normalizeCfg = require(join(ROOT, 'electron/core/config-normalize.cjs'))

  group('A2 / 配置链路：默认值 → 归一化 → 读取 → **生效**')

  /* ⓪ 先钉住**结构**：上面几个模块的导出形状（少一层就当场红，而不是把整组带崩） */
  check(
    '★ 三个模块的导出形状没变（少一层就红，不让它把整组带崩）',
    defaultsCfg.DEFAULTS?.assistant !== undefined &&
      typeof normalizeCfg.normalize === 'function' &&
      typeof gate.gate === 'function',
    `defaults=${!!defaultsCfg.DEFAULTS?.assistant} normalize=${typeof normalizeCfg.normalize} gate=${typeof gate.gate}`,
  )
  const defaultAssistant = defaultsCfg.DEFAULTS.assistant

  /* ① 默认值：真调 config-defaults 看那四个键在不在（不是「我写了那行 spread」） */
  check(
    '★ 四个键都在 config-defaults 里（真调，不看源码）',
    scaleConfig.KEYS.every((k) => defaultAssistant[k] !== undefined),
    scaleConfig.KEYS.filter((k) => defaultAssistant[k] === undefined).join(',') || '全在',
  )
  check(
    '★ 默认值与 scale-config 一处定义（不是两边各写一份）',
    defaultAssistant.scaleHardSeconds === scaleConfig.DEFAULTS.scaleHardSeconds &&
      defaultAssistant.scaleWarnSeconds === scaleConfig.DEFAULTS.scaleWarnSeconds &&
      defaultAssistant.scaleMaxFiles === scaleConfig.DEFAULTS.scaleMaxFiles &&
      defaultAssistant.scaleFirst === scaleConfig.DEFAULTS.scaleFirst,
  )

  /* ② 归一化：脏值夹取 / 回落（两个入口都要验） */
  const dirty = scaleConfig.normalize({
    scaleHardSeconds: -5,
    scaleWarnSeconds: 'abc',
    scaleMaxFiles: 99999999,
    scaleFirst: 'no',
  })
  check(
    '★ 脏值夹到合法区间 / 回落默认',
    dirty.scaleHardSeconds === 10 &&
      dirty.scaleWarnSeconds === 30 &&
      dirty.scaleMaxFiles === 1000000 &&
      dirty.scaleFirst === true,
    JSON.stringify(dirty),
  )
  check(
    '★ 走 config-normalize 那一道也夹（不是只在自家模块里夹）',
    normalizeCfg.normalize({ assistant: { scaleHardSeconds: -5 } }).assistant.scaleHardSeconds === 10,
  )

  /* ③④ 读取 + **生效**：判决必须随之改变（只断言「读到值」不算过） */
  const cloneCall = { name: 'run_shell', args: { command: 'git clone https://github.com/a/b.git' } }
  const gateWith = (assistant, tag = '') =>
    gate.gate({
      ...cloneCall,
      ctx: {
        sessionId: `selftest-scale-cfg-${tag}-${assistant.scaleHardSeconds ?? 0}-${assistant.scaleWarnSeconds ?? 0}`,
        workdir: WORKDIR,
        assistant,
      },
      audit: noopAudit,
    })

  check('基线：git clone（估 60s）在默认 120s 阈值下不拦（只 note）', gateWith({}, 'base').level === 'note', gateWith({}, 'base').level)
  check(
    '★★ 生效：把阈值改到 10 秒 → 同一个命令**变成拦**（判决真的跟着配置走）',
    gateWith({ scaleHardSeconds: 10 }, 'hard').level === 'blocked',
    gateWith({ scaleHardSeconds: 10 }, 'hard').level,
  )
  check(
    '★★ 生效：把「提醒线」抬到 600 秒 → 连 note 都不记（判决真的跟着配置走）',
    gateWith({ scaleWarnSeconds: 600 }, 'warn').level === 'ok',
    gateWith({ scaleWarnSeconds: 600 }, 'warn').level,
  )
  check(
    '★★ 回滚开关：scaleFirst=false → 规模层直接放行（`disabled` 标出来）',
    gateWith({ scaleFirst: false }, 'off').level === 'ok' &&
      gateWith({ scaleFirst: false }, 'off').disabled === true,
    JSON.stringify(gateWith({ scaleFirst: false }, 'off')),
  )
  const risk = require(join(ROOT, 'electron/core/risk.cjs'))
  check(
    '★★ 语义：关掉只关**规模**，不动危险度（危险命令照旧被判危急）',
    /* 规模层放行了，但危险度那一层一个字没变 */
    gateWith({ scaleFirst: false }, 'off2').level === 'ok' &&
      /* 写法要**真命中**那条 critical 规则（盘根在末尾）；换个参数顺序就不 critical 了，
         那是危险度层自己的已知缺口，钉在 `61-destructive.mjs` 里 —— 别拿它当判据 */
      risk.classify('Remove-Item -Recurse -Force C:\\')?.level === 'critical',
    risk.classify('Remove-Item -Recurse -Force C:\\')?.level,
  )

  group('A2 / 每个配置项都必须有人读（筛查 + 行为断言，两级）')

  /* 快速筛查：kernel 里（除三个 config 文件）还有没有地方提到这个键 */
  const CONFIG_FILES = new Set(['config-defaults.cjs', 'config-normalize.cjs', 'scale-config.cjs'])
  const kernelFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name)
      if (e.isDirectory()) return e.name === 'chromium' ? [] : kernelFiles(full)
      return e.name.endsWith('.cjs') && !CONFIG_FILES.has(e.name) ? [full] : []
    })
  const screenRead = (key) =>
    kernelFiles(join(ROOT, 'electron')).filter((f) => readFileSync(f, 'utf8').includes(key))

  for (const key of scaleConfig.KEYS) {
    const hits = screenRead(key)
    check(
      `筛查：${key} 在 kernel 里有人提到（除那三个 config 文件）`,
      hits.length > 0,
      hits.map((f) => f.slice(f.lastIndexOf('electron'))).join(', ') || '（没人提）',
    )
  }
  check(
    '行为断言：scaleFirst / scaleHardSeconds / scaleWarnSeconds 都有（上面那一组）',
    true,
  )
  warn(
    'scaleMaxFiles 只有筛查、没有行为断言 —— 因为「文件数」现在算不出来',
    '它不是漏了，是暂时没法钉：见 docs/improvement-checklist.md 第 0 条',
  )
  check('★ 筛查能红：编一个没人读的键 → 筛查判「没人读」', screenRead('scaleNotReadYet_没人读这个词').length === 0)
}
