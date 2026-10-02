import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   规模预检（A2，用户 2026-10-03 批准）

   缺口的原话在 `docs/安全模型.md` §8：权限层管「能不能」、`risk.cjs` 管「做错了毁不毁
   东西」，**没人管「这次要花多大代价」**。实例：已授权读盘 + 「看看电脑是不是变慢了」
   → `dir /s C:\`：只读、危险度 low，但可能几分钟、几十万文件 —— 两层都不会问。

   这一组钉的是**闸门自己**（离线、不烧模型、不开窗口）：
     ① **每条「该问」都真的能问**：递归 + 逃出工作目录 / 批量外联 / 盘根；
     ② **不许误伤**：单次、有界、正常开发动作（`npm test`、`git status`、单条 curl）不问 ——
        误伤比漏判贵：动不动就拦，用户很快学会闭眼点确认，那比不问更糟；
     ③ 用户这轮**字面上说了范围** → 不问（防误伤，「C 盘」这种中文写法也要认）；
     ④ 本对话内同类不再问（用户亲自调整的：批了扫 C 盘，紧接着扫 D 盘不该再问）；
     ⑤ 接线：咽喉（`tools/index.cjs`）真的挂上了闸门，`ask_user` 答过一次真的记成授权；
     ⑥ 留痕：预估进审计（用户要的「不靠拍，靠数据」）。

   ⚠️ 判据的形状：这里全是**离线**断言 —— 用「肯定该问 / 肯定不该问」的输入喂 `inspect()`，
   `tools.execute` 那条只验「拦下时不执行工具」（阴性，不会真去扫盘）。
   ══════════════════════════════════════════════════════════════ */

const WORKDIR = 'D:\\proj'
/** 造一次 shell 调用（workdir 固定，用户那句话按需给） */
const sh = (command, userText = '') => ({ name: 'run_shell', args: { command }, workdir: WORKDIR, userText })
const noopAudit = () => {}

export async function run() {
  const gate = require(join(ROOT, 'electron/core/tools/scale-gate.cjs'))
  const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))
  const askUser = require(join(ROOT, 'electron/core/tools/ask_user.cjs'))

  group('A2 / 必须问：递归或批量 + 逃出工作目录')

  for (const [label, command] of [
    ['dir /s C:\\', 'dir /s C:\\'],
    ['Get-ChildItem 全盘递归', 'Get-ChildItem -Path C:\\ -Recurse'],
    ['find /', 'find / -name "*.log"'],
    ['grep -r 从根上搜', 'grep -r foo /'],
    ['robocopy 从 C 到 D', 'robocopy C:\\src D:\\dst /E'],
    ['xcopy 整目录', 'xcopy C:\\data\\* D:\\backup\\ /E /S'],
    ['7z 打包大目录', '7z a -r out.7z C:\\big'],
  ]) {
    const v = gate.inspect(sh(command))
    check(`★ ${label} → 问`, v.level === 'ask', `${v.level} / ${v.reasons.join('；')}`)
  }

  group('A2 / 必须问：批量外联（分界是「批量 vs 单次」，不是「联网 vs 本地」）')

  for (const [label, command] of [
    ['wget 递归抓站', 'wget -r https://example.com'],
    ['httrack 整站抓取', 'httrack https://example.com -O out'],
    ['rclone 批量同步', 'rclone sync ./data remote:backup'],
    ['镜像克隆', 'git clone --mirror https://github.com/a/b.git'],
    ['一条命令挂多个地址', 'curl -O https://a.com/1.zip https://a.com/2.zip'],
  ]) {
    const v = gate.inspect(sh(command))
    check(`★ ${label} → 问`, v.level === 'ask' && v.kind === 'batch', `${v.level}/${v.kind}`)
  }

  group('A2 / 不许误伤：单次、有界、正常开发动作')

  for (const [label, command] of [
    ['列当前目录', 'dir'],
    ['列目录', 'ls -la'],
    ['git 状态', 'git status'],
    ['跑测试（有界）', 'npm test'],
    ['装依赖（有界）', 'npm install'],
    ['构建（有界）', 'npm run build'],
    ['克隆一个仓库（单次有界）', 'git clone https://github.com/a/b.git'],
    ['单次抓一个文件', 'curl -O https://example.com/a.zip'],
    ['工作目录里递归搜', 'grep -r foo .'],
    ['工作目录里递归列目录', 'Get-ChildItem -Recurse .'],
  ]) {
    const v = gate.inspect(sh(command))
    check(`${label} → 不拦（最多 note）`, v.level !== 'ask', v.level)
  }

  check(
    '★ 有界重活归「耗时」那一类（审计里别把 npm test 记成「扫描」）',
    gate.inspect(sh('npm test')).kind === 'long',
    String(gate.inspect(sh('npm test')).kind),
  )
  check(
    'list_dir depth=1 → 不问',
    gate.inspect({ name: 'list_dir', args: { path: 'C:\\', depth: 1 }, workdir: WORKDIR }).level === 'ok',
  )
  check(
    '★ list_dir 递归列盘根 → 问',
    gate.inspect({ name: 'list_dir', args: { path: 'C:\\', depth: 4 }, workdir: WORKDIR }).level === 'ask',
  )
  check(
    '★ 一次一个目标的工具（read_file / browse）不构成规模',
    gate.inspect({ name: 'read_file', args: { path: 'C:\\a.txt' }, workdir: WORKDIR }).level === 'ok' &&
      gate.inspect({ name: 'browse', args: { url: 'https://x.com' }, workdir: WORKDIR }).level === 'ok',
  )

  group('A2 / 用户这轮说了范围 → 不问（防误伤）')

  check(
    '★「帮我把 C 盘扫一遍」+ dir /s C:\\ → 直接做',
    gate.inspect(sh('dir /s C:\\', '帮我把 C 盘扫一遍（只读）')).level === 'ok',
    gate.inspect(sh('dir /s C:\\', '帮我把 C 盘扫一遍（只读）')).reasons.join('；'),
  )
  check(
    '★ 提到别的盘不算说清（说了 D 盘挡不住扫 C 盘）',
    gate.inspect(sh('dir /s C:\\', '看看 D 盘那个项目')).level === 'ask',
  )
  check(
    '★ 用户没说话（空）→ 照问',
    gate.inspect(sh('dir /s C:\\', '')).level === 'ask',
  )

  group('A2 / 本对话内同类不再问（用户 2026-10-03 调整）')

  gate.reset()
  const s1 = 'selftest-scale-s1'
  const first = gate.gate({ name: 'run_shell', args: { command: 'dir /s C:\\' }, ctx: { sessionId: s1, workdir: WORKDIR }, audit: noopAudit })
  check(
    '★ 第一次拦下：拦的是工具，话还给模型（让它去 ask_user）',
    first.level === 'blocked' && /ask_user/.test(first.text) && first.kind === 'scan',
    first.text.slice(0, 44),
  )
  check('★ 拦截文案里带着信号与预估（模型才好把范围说清）', /预估/.test(first.text) && /盘根|递归/.test(first.text), first.text.slice(0, 80))
  check('★ 明确说了「别换个写法绕过去」', /别换个写法绕过去/.test(first.text))
  check(
    '★ 拦下时的标记与判据共用一处定义（判据靠它区分「被拦」与「真跑了」）',
    first.text.includes(gate.BLOCKED_MARK) && typeof gate.BLOCKED_MARK === 'string',
    gate.BLOCKED_MARK,
  )

  gate.noteAsked(s1)
  const again = gate.gate({ name: 'run_shell', args: { command: 'dir /s D:\\' }, ctx: { sessionId: s1, workdir: WORKDIR }, audit: noopAudit })
  check('★ 答过一次之后，同一对话里扫 D 盘不再问（用户点名的那个例子）', again.level === 'ok', again.level)
  check(
    '★ 别的对话照问（授权不跨对话）',
    gate.gate({ name: 'run_shell', args: { command: 'dir /s C:\\' }, ctx: { sessionId: 'selftest-scale-s2', workdir: WORKDIR }, audit: noopAudit }).level === 'blocked',
  )
  check(
    '★ 批过「扫描」不等于批过「批量外联」',
    gate.gate({ name: 'run_shell', args: { command: 'wget -r https://example.com' }, ctx: { sessionId: s1, workdir: WORKDIR }, audit: noopAudit }).level === 'blocked',
  )
  gate.reset()
  check('reset 之后授权清空（测试隔离用）', gate.grantsFor(s1).length === 0)

  group('A2 / 接线：咽喉真的挂上了闸门')

  const out = String(
    await tools.execute('run_shell', { command: 'dir /s C:\\' }, { sessionId: 'selftest-scale-wire', workdir: WORKDIR }),
  )
  check(
    '★ 真调 tools.execute：重操作被拦下（工具**没跑**），话还给模型',
    /先别做/.test(out) && /ask_user/.test(out),
    out.slice(0, 50),
  )
  check('★ 而且没真的执行命令（拦截是阴性行为：不会有输出里的目录列表）', !/Directory|目录/.test(out), out.slice(0, 60))

  const s3 = 'selftest-scale-s3'
  gate.gate({ name: 'run_shell', args: { command: 'dir /s C:\\' }, ctx: { sessionId: s3, workdir: WORKDIR }, audit: noopAudit })
  await askUser.run(
    { questions: [{ question: '要扫全盘吗？', options: [{ label: '扫', effect: '大约 5 分钟' }] }] },
    {
      sessionId: s3,
      clarify: async () => ({
        answers: [{ question: '要扫全盘吗？', choice: '扫', text: '' }],
        skipped: false,
        timeout: false,
      }),
    },
  )
  check(
    '★ 用户答过一次规模确认 → 这个对话的「扫描」授权真的记上了（不是靠模型自觉）',
    gate.granted(s3, 'scan') === true,
    JSON.stringify(gate.grantsFor(s3)),
  )
  gate.reset()

  group('A2 / 提示词层：模型先判断（闸门只兼底）')

  const stack = require(join(ROOT, 'electron/core/prompt-stack.cjs'))
  const rulesOn = stack.workRules({ planFirst: true, clarifyFirst: true })
  check(
    '★ 开着的时候注入「动手前先掂量代价」',
    /掂量代价/.test(rulesOn) && /多大范围/.test(rulesOn),
    rulesOn.includes('掂量代价') ? '有' : '没有',
  )
  check(
    '★ 文案里说清了「有界重活不用问，但要说一句」',
    /不用问/.test(rulesOn) && /预计多久/.test(rulesOn),
  )
  check(
    '★ 也说清了例外：用户说了范围 / 小范围只读探测 → 直接做',
    /已经说了范围/.test(rulesOn) && /小范围只读探测/.test(rulesOn),
  )
  check(
    '★ 和「开工前对齐」共用一个开关：关掉 clarifyFirst → 两条都不注入',
    !/掂量代价/.test(stack.workRules({ planFirst: true, clarifyFirst: false })),
  )
  check(
    '★ 静音时也不注入（不让问的时候还写着「先问规模」，模型只会来回犹豫）',
    !/掂量代价/.test(stack.workRules({ planFirst: true, clarifyMuted: true })),
  )
  check(
    '★ 拆文件没把老规矩弄丢（先看再改 / 先给计划 / 其余规矩都在）',
    /先看再改/.test(rulesOn) &&
      /plan 块/.test(rulesOn) &&
      /edit_file/.test(rulesOn) &&
      /回答用简体中文/.test(rulesOn),
    String(rulesOn.length),
  )
  check(
    '关掉 planFirst 只去掉计划那一条（其余照旧）',
    !/plan 块/.test(stack.workRules({ planFirst: false })) &&
      /掂量代价/.test(stack.workRules({ planFirst: false })),
  )

  group('A2 / 留痕：预估进审计（用户要的「不靠拍，靠数据」）')

  const entries = []
  gate.gate({
    name: 'run_shell',
    args: { command: 'dir /s C:\\' },
    ctx: { sessionId: 'selftest-scale-audit', workdir: WORKDIR },
    audit: (entry) => entries.push(entry),
  })
  check('★ 拦下时写了审计条目', entries.length === 1 && String(entries[0].tool).startsWith('scale-gate:'), JSON.stringify(entries[0]?.tool ?? null))
  const scale = entries[0]?.extras?.scale ?? {}
  check(
    '★ 审计里带着预估（秒数有、文件数如实写「未知」）',
    scale.seconds >= 120 && scale.files === null && scale.basis === 'table',
    JSON.stringify(scale),
  )
  check('★ 审计里记着判决（blocked）与范围（drive-root）', scale.decision === 'blocked' && scale.scope === 'drive-root')
  check('★ 命中的信号也记下来了（将来校准默认值要靠这些）', Array.isArray(scale.reasons) && scale.reasons.length > 0, (scale.reasons ?? []).join('；'))

  const noteEntries = []
  gate.gate({
    name: 'run_shell',
    args: { command: 'npm test' },
    ctx: { sessionId: 'selftest-scale-audit', workdir: WORKDIR },
    audit: (entry) => noteEntries.push(entry),
  })
  check('★ note（有界重活）也留痕，但**不拦**', noteEntries.length === 1 && noteEntries[0].extras.scale.decision === 'note')
  check('★ 授权放行的那次也记一笔（「省掉了几次打扰」也是数据）', (() => {
    gate.reset()
    const s = 'selftest-scale-count'
    gate.gate({ name: 'run_shell', args: { command: 'dir /s C:\\' }, ctx: { sessionId: s, workdir: WORKDIR }, audit: noopAudit })
    gate.noteAsked(s)
    const seen = []
    gate.gate({ name: 'run_shell', args: { command: 'dir /s C:\\' }, ctx: { sessionId: s, workdir: WORKDIR }, audit: (e) => seen.push(e) })
    gate.reset()
    return seen[0]?.extras?.scale?.decision === 'granted'
  })())
}
