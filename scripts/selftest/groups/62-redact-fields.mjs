import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   自由文本字段名脱敏（键名口径对齐 SECRET_KEY）

   redact.cjs 有两层：
     ① 结构化对象的键（`SECRET_KEY`）—— 覆盖较全
     ② **自由文本**里的 `字段名 = 值`（PATTERNS 最后一条）—— 原来只有 7 个候选

   漏的那一层就是「密钥原样落盘」的口子：日志行、审计 jsonl、错误信息都是
   自由文本，`sessionId=<密钥>` 这类写法结构层根本管不着。

   ★ 本组的写法要点：值一律用**中性**的 `abc123def456`，绝不用 `sk-…`。
     用假 key 会被「厂商前缀」那条规则救下来 → 测试全绿但实际还是漏
     （这正是这个 bug 能活到现在的假绿机制）。所以下面专门有一条守卫：
     单独把这个值喂进去必须原样返回，证明它不靠别的规则兜底。
   ══════════════════════════════════════════════════════════════ */

const redact = require(join(ROOT, 'electron/core/redact.cjs'))
const P = redact.PLACEHOLDER

/** 所有用例共用的值：不含任何厂商前缀，只能靠字段名规则打码 */
const VALUE = 'abc123def456'

/** [文本, 说明] —— 这些字段名以前在自由文本里会漏 */
const MUST_MASK = [
  [`token=${VALUE}`, '裸 token + `=`'],
  [`TOKEN: ${VALUE}`, '大写 TOKEN + `:`'],
  [`secret=${VALUE}`, '裸 secret'],
  [`secretKey=${VALUE}`, 'secretKey（camelCase）'],
  [`secret_key=${VALUE}`, 'secret_key（snake_case）'],
  [`access_key=${VALUE}`, 'access_key'],
  [`bearer_token=${VALUE}`, 'bearer_token'],
  [`privateToken=${VALUE}`, 'privateToken'],
  [`credential=${VALUE}`, 'credential'],
  [`credentials: ${VALUE}`, 'credentials（复数）'],
  [`session=${VALUE}`, '裸 session'],
  [`sessionId=${VALUE}`, 'sessionId'],
  [`Authorization: ${VALUE}`, '裸 authorization（HTTP 头写法）'],
  [`Private-Token: ${VALUE}`, 'Private-Token'],
  [`"token": "${VALUE}"`, 'JSON 里的 token'],
  [`apiKey = ${VALUE}`, '分隔符两侧有空格'],
]

/** 原本就覆盖的，不许改坏 */
const STILL_MASKED = [
  [`password=${VALUE}`, 'password'],
  [`api_key=${VALUE}`, 'api_key'],
  [`access_token=${VALUE}`, 'access_token'],
  [`client_secret=${VALUE}`, 'client_secret'],
]

/** 这些**必须原样留着** —— 打码打过头，用户会整个不信这套脱敏 */
const MUST_KEEP = [
  ['token 这个字段怎么传，见文档第三章', '光有词、后面没有分隔符'],
  [`token=${VALUE.slice(0, 3)}`, '值太短（< 6）不成密钥'],
  ['讨论 password 字段的校验规则时不要打码', '光有词、没有 `字段名=值` 的形状'],
]

export async function run() {
  group('安全 / 自由文本字段名脱敏')

  /* ── 0. 反假绿守卫：这个值不靠别的规则兜底 ───────────────── */
  check(
    '★ 中性值本身不会被别的规则打码（否则下面全是假绿）',
    redact.redact(VALUE) === VALUE,
    redact.redact(VALUE),
  )

  /* ── 1. 原来会漏的字段名 ──────────────────────────────── */
  for (const [text, why] of MUST_MASK) {
    const out = redact.redact(text)
    check(`★ 打码：${why}`, !out.includes(VALUE) && out.includes(P), out)
  }

  /* ── 2. 只换值，键名和分隔符原样留下（可读性） ─────────── */
  check('键名和分隔符被保留，只换掉值', redact.redact(`token=${VALUE}`) === `token=${P}`)

  /* ── 3. 反向：原本覆盖的字段名不许改坏 ─────────────────── */
  for (const [text, why] of STILL_MASKED) {
    const out = redact.redact(text)
    check(`仍然命中：${why}`, !out.includes(VALUE) && out.includes(P), out)
  }

  /* ── 4. 反向：不许误伤普通文本 ─────────────────────────── */
  for (const [text, why] of MUST_KEEP) {
    check(`不动：${why}`, redact.redact(text) === text, redact.redact(text))
  }

  /* ── 5. 相邻规则不许被顺手改坏（Bearer / 厂商前缀） ─────── */
  check(
    'Bearer 规则仍然生效',
    !redact.redact('Authorization: Bearer abcdefghijklmnopqrst').includes('abcdefghijklmnopqrst'),
  )
  check(
    '厂商前缀规则仍然生效（靠前缀兜底，不是靠字段名）',
    redact.redact('key=sk-abcdefghijklmnopqrstuvwxyz').includes(P),
  )

  /* ── 6. 源码守位：候选清单不许被改窄回去 ─────────────── */
  group('安全 / 字段名候选清单守位')

  const src = readFileSync(join(ROOT, 'electron/core/redact.cjs'), 'utf8')
  /* 抓出那条自由文本规则，取出 `(?:…|…)` 里的候选清单 */
  const rule = src.split('\n').find((line) => line.includes(']{6,}')) ?? ''
  const candidates = (rule.match(/\(\?:([^)]+)\)/) ?? [, ''])[1].split('|')

  const EXPECTED = [
    'api[_-]?key',
    'apikey',
    'secret[_-]?key',
    'client[_-]?secret',
    'access[_-]?token',
    'access[_-]?key',
    'auth[_-]?token',
    'bearer[_-]?token',
    'private[_-]?token',
    'session[_-]?id',
    'token',
    'secret',
    'password',
    'passwd',
    'pwd',
    'credentials?',
    'authorization',
    'session',
  ]
  check(
    '★ 字段名候选一个不少（少一个就漏一整类字段）',
    EXPECTED.every((name) => candidates.includes(name)),
    `实有：${candidates.join('|')}`,
  )
  /*
   * ★ 已加强：值字符类除「空白 / 引号 / 分隔符」外**还要排除反斜杠 `\`**。
   *   少排一个 `\`，就会把 JSON 里的 `\"` 吃掉 → 会话记录坏成非法 JSON
   *   （真机代价：一条会话 39 行回复记录报废，见 31-session-redact）。
   *   这条仍然是防「放宽」的守位：换形式、去下限、把反斜杠放回来都会红。
   */
  check(
    '★ 值捕获组没被放宽（`[^\\s"\',;&)\\]}\\\\]` + 6 位下限是防误伤与防 JSON 破坏的关键）',
    rule.includes('[^\\s"\',;&)\\]}\\\\]{6,}'),
    rule,
  )

  /* 第 17 项：凭证库明文升级（同一个 run 里顺带跑，不单开组 —— groups.mjs 贴红线） */
  runCredentialUpgradeChecks()
}

/* ══════════════════════════════════════════════════════════════
   凭证库 · 明文升级与诊断状态（第 17 项，2026-11-11）

   病：界面的「API Key 存哪」只看 `encryptionAvailable`，不看**盘上的 backend**。
   一台拿得到 safeStorage 的机器上，如果凭证库是纯 Node 环境（或更早）写成的
   **明文库**，界面会显示「已用系统加密（plain）」—— 明明是明文，却告诉用户已加密。

   修：`status()` 多报 `plainOnDisk` / `canUpgrade`；`upgrade()` 保数据地原地升级。
   这里钉三件：判据分开、升级保数据、留不下档就中止。
   ══════════════════════════════════════════════════════════════ */
export function runCredentialUpgradeChecks() {
  group('凭证库 / 明文升级（第 17 项）')

  const cred = require(join(ROOT, 'electron/core/credentials.cjs'))
  const maintenance = require(join(ROOT, 'electron/core/credentials-maintenance.cjs'))

  /* ① 判据分开：status 必须报 plainOnDisk / canUpgrade，不能只给 encryptionAvailable */
  const s = cred.status()
  check(
    '★★★ status 分别报「盘上是否明文」与「能否升级」（只看 encryptionAvailable 会把明文说成已加密）',
    typeof s.plainOnDisk === 'boolean' && typeof s.canUpgrade === 'boolean',
    JSON.stringify(s),
  )
  check(
    '★ plainOnDisk 与 backend 自洽（backend 不是 safeStorage 且有凭证才算明文）',
    s.plainOnDisk === (s.backend !== 'safeStorage' && s.count > 0),
    `backend=${s.backend} count=${s.count} plainOnDisk=${s.plainOnDisk}`,
  )
  check(
    '★ canUpgrade 必须是 plainOnDisk 的子集（已经是系统加密就不该说「能升级」）',
    !s.canUpgrade || s.plainOnDisk,
    `canUpgrade=${s.canUpgrade} plainOnDisk=${s.plainOnDisk}`,
  )

  /* ② 升级函数的形状：保数据、留档、失败中止 */
  check('★ 导出 upgrade', typeof cred.upgrade === 'function')
  const src = require('node:fs').readFileSync(
    join(ROOT, 'electron/core/credentials-maintenance.cjs'),
    'utf8',
  )
  check(
    '★★★ 升级前先留档（`keepCorruptCopy`），留不下就中止 —— 不能在没有退路时重写凭证库',
    /keepCorruptCopy/.test(src) && /留档失败，已中止升级/.test(src),
  )
  check(
    '★★ 升级是**逐条重加密**（读旧后端 → 写 safeStorage），不是清空重来',
    /deps\.decrypt\(entry, data\.backend\)/.test(src) && /deps\.encrypt\(plain, 'safeStorage'\)/.test(src),
  )
  check(
    '★★ 已经是 safeStorage 时直接返回（不重复升级、不改动文件）',
    /已经是系统加密，无需升级/.test(src),
  )
  check(
    '★ 本机没有加密能力时抛错（不静默降级成「升级成功」）',
    /拿不到系统加密能力/.test(src),
  )

  /* ③ 通道接线：界面点得到，且通道进了清单（漏了打包自检会报 channelsMissing） */
  const channels = require('node:fs').readFileSync(join(ROOT, 'electron/ipc-channels.cjs'), 'utf8')
  check('★ credentials:upgrade 进了通道清单', channels.includes("'credentials:upgrade'"))
  const preload = require('node:fs').readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  check('★ preload 暴露了 credentialsUpgrade', preload.includes('credentialsUpgrade:'))
  const reg = require('node:fs').readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8')
  check(
    '★ 注册点装上了（handler 建了不用 = 静默不生效）',
    reg.includes('handlers/credentials-upgrade.cjs'),
  )

  /* ④ 界面判据：不能再用 encryptionAvailable 决定「已加密」 */
  const ui = require('node:fs').readFileSync(
    join(ROOT, 'src/components/settings/security/AccessProtectionGroup.tsx'),
    'utf8',
  )
  const code = ui
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join('\n')
  check(
    '★★★ 界面按 backend 判「已加密」，不是按 encryptionAvailable',
    /creds\.backend === 'safeStorage'/.test(code),
    '「已加密」那一档没有按 backend 判断',
  )
  /*
   * ★ 精确判据：`已用系统加密` 那句**不能**由 encryptionAvailable 决定。
   *   注意 `encryptionAvailable` 本身仍有正当用途（判断「这台机器支不支持加密」），
   *   所以不能一刀切成「全文件禁出现」—— 只看它有没有贴在那句话的条件上。
   */
  const at = code.indexOf('已用系统加密')
  const near = at >= 0 ? code.slice(Math.max(0, at - 260), at) : ''
  check(
    '★★★ 「已用系统加密」不是 encryptionAvailable 的分支（那会把明文库说成已加密）',
    at >= 0 && !/encryptionAvailable/.test(near),
    near.slice(-120),
  )
  check('★ 明文且能升级时给得出升级入口', /升级为系统加密/.test(code))
}
