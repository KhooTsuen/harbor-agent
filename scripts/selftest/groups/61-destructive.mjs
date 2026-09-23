import { asked, ctx, require, join, ROOT, tools, riskCore } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   破坏性命令：**必须**被拦或必须问，绝不能静默执行

   这一组是 2026-09-23 那次排查的回归锁。当时发现：在
   `permission: 'full'` + `shellPolicy: { medium: 'allow' }` 这个**真实配置**下，
   一批会毁掉机器或数据的命令被判成 medium → 直接执行、**连问都不问**：

     · `Format-Volume -DriveLetter C`（PowerShell 的格式化，`format c:` 的同义词）
     · `net user x P@ss /add`（建账户）、`net localgroup administrators x /add`（提权）
     · `python -c "…shutil.rmtree('E:/')"`（内联脚本删盘根）
     · `find . -delete` ← **判成 low**，`find` 在只读白名单里，而白名单只看命令开头

   根因不是「黑名单少写了几条」，是**两个设计问题**：
     ① 模式表全是 cmd / unix 写法，PowerShell 的同义命令一个都没覆盖
     ② 只读白名单 `^…` 只审**命令开头**，后面跟什么参数完全不看
   所以这里刻意**不逐条测命令名**（那种测试补不完），而是测**类别性质**：
   任何「会毁掉数据 / 提权 / 代码不可见」的东西，在最宽松的策略下也不许静默放行。
   ══════════════════════════════════════════════════════════════ */

/** 用户真实的 shellPolicy —— 刻意用最宽松的一档来测 */
const LOOSE = { medium: 'allow', high: 'allow', critical: 'allow' }

/** 分类上必须是 critical，执行上必须「不问就直接拒」 */
const MUST_BLOCK = [
  [`Format-Volume -DriveLetter C`, '格式化分区（PowerShell 写法）'],
  ['Clear-Disk -Number 0 -RemoveData', '清空磁盘'],
  ['Initialize-Disk -Number 0', '初始化磁盘'],
  ['net user x P@ss /add', '创建系统账户'],
  ['net localgroup administrators x /add', '把账户加进管理员组'],
  ['python -c "import shutil; shutil.rmtree(\'E:/\')"', '内联脚本删整个盘'],
  ['node -e "require(\'fs\').rmSync(\'E:/\', {recursive:true})"', '内联脚本删整个盘'],
  ['Stop-Computer -Force', '关机'],
  ['Restart-Computer -Force', '重启'],
  ['vssadmin delete shadows /all /quiet', '删卷影副本'],
  [`reg delete HKLM\\Software\\Selftest /f`, '删注册表 HKLM'],
  ['format c:', '格式化磁盘'],
  ['powershell -c "Remove-Item -Recurse -Force C:\\"', '递归删整个盘（PowerShell）'],
  ['Remove-Item -Path C:\\ -Recurse -Force', '递归删盘根（-Path 写法）'],
  [`wmic logicaldisk where "DeviceID='C:'" delete`, 'WMIC 删卷'],
  [`dd if=/dev/zero of=C:\\Windows\\system32\\x`, 'dd 覆盖盘上文件'],
]

/** 分类上必须是 high，执行上必须「先问」 */
const MUST_ASK = [
  ['find . -exec rm {} +', 'find 边搜边执行'],
  ['schtasks /delete /tn selftest /f', '删计划任务'],
  ['msiexec /i evil.msi /quiet', '静默装 msi'],
  ['python -c "print(1)"', '内联脚本（代码在参数里）'],
  ['node -e "console.log(1)"', '内联脚本（代码在参数里）'],
  [`takeown /f C:\\Windows /r`, '夺取文件所有权'],
  ['Set-ExecutionPolicy Bypass -Scope LocalMachine', '放开脚本执行策略'],
  ['runas /user:admin cmd', '提权'],
  [`reg add HKLM\\Software\\x /v y /d z`, '改注册表'],
  ['Remove-Item -Recurse ./build', '递归删子目录仍是 high（别误伤）'],
]

/** 这些**必须还是 low** —— 治漏不能治成「什么都要问」，误报多了用户会整个关掉分级 */
const STILL_READONLY = [
  ['ls -la', 'ls 带参数'],
  ['dir /s /b', 'dir 带参数'],
  ['git status', 'git status'],
  ['grep -r foo .', 'grep -r（-r 是"递归搜索"，不是"递归删除"）'],
  ['find . -name "*.cjs"', 'find 只搜不删'],
  ['node -v', 'node -v'],
  [`Get-ChildItem C:\\`, 'PowerShell 只读'],
]

export async function run() {
  const patterns = require(join(ROOT, 'electron/core/risk-patterns.cjs'))

  group('风险分级 / 会毁掉东西的命令（F1 回归）')

  /* ── ① 分类：模式表认不认得出来 ── */

  for (const [command, why] of MUST_BLOCK) {
    const level = riskCore.classify(command).level
    check(`★ ${why} 判为危急`, level === 'critical', `实际 ${level}｜${command}`)
  }

  for (const [command, why] of MUST_ASK) {
    const level = riskCore.classify(command).level
    check(`★ ${why} 判为高风险`, level === 'high', `实际 ${level}｜${command}`)
  }

  /*
   * ★ 这一条是整个 F1 的核心断言。
   *   把 medium / high / critical **全部**配成 allow（比用户真实配置还宽松），
   *   这些命令也不许出现 action === 'allow' —— 因为 action==='allow' 就意味着
   *   `permission: 'full'` 下**不问、直接执行**。
   */
  const silentlyAllowed = [...MUST_BLOCK, ...MUST_ASK].filter(
    ([command]) => riskCore.decide(riskCore.classify(command), LOOSE).action === 'allow',
  )
  check(
    '★★ 策略全配成 allow，这些命令也不允许静默执行',
    silentlyAllowed.length === 0,
    silentlyAllowed.map(([c]) => c).join(' ｜ '),
  )

  /* ── ② 只读白名单：别误伤 ── */

  for (const [command, why] of STILL_READONLY) {
    const level = riskCore.classify(command).level
    check(`只读仍然放行：${why}`, level === 'low', `实际 ${level}｜${command}`)
  }

  /*
   * ★ 白名单原来只审命令**开头**，`find . -delete` 因此被判成 low 且静默执行。
   *   这两条直接钉住 `isReadOnlyCommand` 的语义：光开头对不算，整条都得像只读。
   */
  check(
    '★★ `find . -delete` 不再算只读',
    patterns.isReadOnlyCommand('find . -delete') === false,
  )
  check(
    '★ 带 shell 元字符的不算只读（能拼命令就能藏东西）',
    patterns.isReadOnlyCommand('dir a.txt | findstr x') === false,
  )
  check(
    '★ 参数里的破坏性开关能让"只读命令"失去只读资格',
    patterns.MUTATING_ARG.test('-delete') && patterns.MUTATING_ARG.test('-exec'),
  )
  check(
    '★ 但 `-r` 这种同名不同义的不能收进破坏性开关里（否则 grep -r 被误伤）',
    patterns.MUTATING_ARG.test('-r') === false,
  )

  /* ── ③ 分级别治过头：中风险该爽快放行 ── */

  const medium = riskCore.classify('mkdir foo')
  check('中风险仍然是中风险', medium.level === 'medium', medium.level)
  check(
    '★ medium: allow 确实还是 allow（不然"别烦我"这个设置就废了）',
    riskCore.decide(medium, LOOSE).action === 'allow',
    JSON.stringify(riskCore.decide(medium, LOOSE)),
  )

  /* ── ④ 真跑一遍：execute() 那一层的实际行为 ── */

  /*
   * 全程用「一律拒绝」的 confirm：
   *   · 不会真的执行任何东西（MUST_ASK 里那些命令有真实副作用）
   *   · 又能靠 probe 有没有被调用，分辨「拒了」和「问了之后拒了」
   */
  const probe = []
  const denyCtx = {
    ...ctx,
    confirm: async (request) => {
      probe.push(request)
      return false
    },
  }

  for (const [command, why] of MUST_BLOCK) {
    probe.length = 0
    const result = await tools.execute('run_shell', { command }, denyCtx)
    check(
      `★ ${why}：连问都不问直接拒`,
      probe.length === 0 && result.startsWith('错误：'),
      `问了 ${probe.length} 次｜${result.slice(0, 80)}`,
    )
  }

  for (const [command, why] of MUST_ASK) {
    probe.length = 0
    const result = await tools.execute('run_shell', { command }, denyCtx)
    check(
      `★ ${why}：弹了确认，拒绝后不执行`,
      probe.length > 0 && result.includes('拒绝'),
      `问了 ${probe.length} 次｜${result.slice(0, 80)}`,
    )
  }

  /*
   * `find . -delete` 单独测：它的目标就是当前目录，`run_shell` 那层的
   * DANGEROUS 会**直接拒掉**（进不到确认这一步）。两种拦法都算合格，
   * 要求只有一条 —— 不许未经确认就执行。
   */
  probe.length = 0
  const findDelete = await tools.execute('run_shell', { command: 'find . -delete' }, denyCtx)
  check(
    '★★ `find . -delete`（曾判成 low 静默执行）：没确认就不许执行',
    findDelete.startsWith('错误：') || probe.length > 0,
    findDelete.slice(0, 80),
  )

  /* 确认门本身没坏：把 confirm 换成「允许」，写类工具照旧能跑通 */
  asked.length = 0
  const allowed = await tools.execute(
    'run_shell',
    { command: 'git status' },
    { ...ctx, confirm: async (request) => (asked.push(request), true) },
  )
  check('低风险命令不打扰用户（git status 不该弹确认）', asked.length === 0, allowed.slice(0, 80))
}
