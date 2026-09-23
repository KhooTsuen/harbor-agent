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
  check(
    '值捕获组没被放宽（`[^\\s"\',;&)\\]}]` + 6 位下限才是防误伤的关键）',
    rule.includes('[^\\s"\',;&)\\]}]{6,}'),
    rule,
  )
}
