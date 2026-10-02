import { asked, ctx, require, join, ROOT, tools, riskCore } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   破坏性命令：**必须**被拦或必须问，绝不能静默执行

   这一组是 2026-09-23 那次排查的回归锁。当时发现：在
   `permission: 'full'` + `shellPolicy: { medium: 'allow' }` 这个**真实配置**下，
   一批会毁掉机器或数据的命令被判成 medium → 直接执行、**连问都不问**：
   `Format-Volume`（`format c:` 的 PowerShell 同义词）、`net user x P@ss /add`（建账户）、
   `python -c "…shutil.rmtree('E:/')"`，还有 `find . -delete`（**判成 low** ——
   `find` 在只读白名单里，而白名单只看命令开头）。

   根因不是「黑名单少写了几条」，是**两个设计问题**：
     ① 模式表全是 cmd / unix 写法，PowerShell 的同义命令一个都没覆盖
     ② 只读白名单 `^…` 只审**命令开头**，后面跟什么参数完全不看
   所以这里刻意**不逐条测命令名**（那种测试补不完），而是测**类别性质**：
   任何「会毁掉数据 / 提权 / 代码不可见」的东西，在最宽松的策略下也不许静默放行。

   2026-10-03 加：「递归删除 + 危险目标」的写法穷举（`risk-targets.cjs`）——
   旧规则要求盘根在**最后一个参数**，实测 46 条里漏 28 条。
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

  /* ★ 2026-10-03 补：这 5 条原来在 `KNOWN_GAP_HIGH` 里**按坏行为钉住**，现在改好了 */
  ['Remove-Item -Recurse C:\\ -Force', '递归删盘根：盘根夹在中间'],
  ['Remove-Item C:\\ -Recurse -Force', '递归删盘根：盘根在开头'],
  ['Remove-Item "C:\\" -Recurse -Force', '递归删盘根：盘根带引号'],
  ['Remove-Item -Confirm:$false -Recurse C:\\', '递归删盘根：带 -Confirm 开关'],
  ['rm -rf /', 'unix 写法删根（旧注释里当参照、自己判 high 的那条）'],

  /* ── 同一类灾难的其它写法（口径：位置 / 引号 / 额外开关都不该影响判定）── */
  ['rm -rf C:\\', '盘根（windows）'],
  ['rm -rf "/"', '盘根带引号'],
  ['rm -rf /*', '盘根通配'],
  ['rm -rf C:/', '盘根（正斜杠）'],
  ['del /s /q C:\\*.*', '盘根 + `*.*` 通配（「整个盘」的另一种写法）'],
  ['rm -rf /usr', '系统目录（unix）'],
  ['rm -rf C:\\Windows', '系统目录（windows）'],
  ['rd /s /q C:\\Windows', 'rd 删系统目录'],
  ['del /s /q C:\\', 'cmd 递归删盘根'],
  ['bash -c "rm -rf /"', '包在 shell -c 里（和 sudo 一样，看的是内容）'],

  /* ── 家目录：**本身**和一级标准目录（`~/Documents/project` 不算，见反向组）── */
  ['rm -rf $env:USERPROFILE', '家目录（变量）'],
  ['rm -rf ~', '家目录（~）'],
  ['rm -rf ~/Documents', '家目录下的一级标准目录'],
  ['rm -rf C:\\Users\\me\\Documents', '家目录下的一级标准目录（windows 写法）'],
  ['rm -rf C:\\Users', '所有用户的父目录'],
  ['rm -rf /home', '所有用户的父目录（unix）'],

  /* ── 间接写法：目标和动作不在同一条命令里 ── */
  ['find / -delete', 'find 边搜边删（起点是根）'],
  ['find / -exec rm -rf {} \\;', 'find -exec 删根'],
  ['echo / | xargs rm -rf', 'xargs 把根喂给 rm'],
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

/**
 * ★★ 治漏不能治过头：**绝不能**变成 critical 的（误报多了用户会关掉整个分级）。
 * 三种情况必须原地不动 —— ① 相对路径（`./build` / `*` / `./*.tmp`）；
 * ② 家目录・标准目录**再往下一层**；③ 名字像但不是（`/usrx` / `~/Projects`），
 * 以及目标和动作**不在同一段**里（旁边那句 `grep` 里的 `/usr` 不算目标）。
 */
const MUST_NOT_CRITICAL = [
  ['rm -rf ./build', 'high', '删构建产物'],
  ['rm -rf ./node_modules', 'high', '删依赖目录'],
  ['rm -rf ./tmp/cache', 'high', '删缓存'],
  ['rm -rf *', 'high', '当前目录下的所有东西（相对，不是根）'],
  ['rm -rf .', 'high', '当前目录'],
  ['rm -rf /tmp/harbor-scratch', 'high', '/tmp 不是系统目录（故意没收）'],
  ['rm -rf $env:TEMP\\harbor', 'high', 'TEMP 只是临时目录'],
  ['rm -rf ~/projects/foo', 'high', '家目录**下面**的项目'],
  ['rm -rf ~/Documents/project', 'high', '标准目录**下面**的东西（只认目录本身）'],
  ['rm -rf ~/Projects', 'high', '自建同名目录（只看深度，不看名字）'],
  ['rm -rf C:\\Users\\me\\projects\\foo\\node_modules', 'high', '家目录深处的产物目录'],
  ['rm -rf /usrx', 'high', '名字像 /usr 但不是（边界不能模糊）'],
  ['rm -rf ./*.tmp', 'high', '相对路径 + 通配（相对就是相对）'],
  ['Remove-Item -Recurse -Force ./build', 'high', 'PowerShell 删构建产物'],
  ['find ./build -delete', 'high', 'find 删相对路径'],
  ['echo ./build | xargs rm -rf', 'high', 'xargs 喂相对路径'],
  ['ls | xargs rm -rf', 'high', 'xargs 的输入是当前目录（源不明确，不升级）'],
  ['rm -rf ./build && grep -r foo /usr/share/doc', 'high', '旁边那句 grep 里的 /usr 不算目标'],
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

  /* ── ①′ 反向：治漏不能治过头（升级成 critical 的那批，这里必须原地不动）── */

  for (const [command, level, why] of MUST_NOT_CRITICAL) {
    const actual = riskCore.classify(command).level
    check(`不许升成 critical：${why}`, actual === level, `期望 ${level}｜实际 ${actual}｜${command}`)
  }

  /*
   * ★ 这一条是整个 F1 的核心断言。用**出厂的默认策略**：不论用户把工具权限开到哪一档，
   *   危急 → block（直接拒，连问都不问）；高风险 → ask。判定放在**默认值**上，
   *   而不是「偷偷推翻用户的选择」（2026-09-29 之前的 `decide()` 会强制降级，
   *   后果是真机审计里那条 `approval=false` ——「设置里写了但不生效」本身就是 bug）。
   */
  const DEFAULT = { medium: 'ask', high: 'ask', critical: 'block' }
  const silentlyAllowed = [...MUST_BLOCK, ...MUST_ASK].filter(
    ([command]) => riskCore.decide(riskCore.classify(command), DEFAULT).action === 'allow',
  )
  check(
    '★★ 默认策略下，这些命令没有一条能静默执行',
    silentlyAllowed.length === 0,
    silentlyAllowed.map(([c]) => c).join(' ｜ '),
  )
  check(
    '★ 危急默认是「拒」（不是问）—— 用户没动过设置时，毁数据的命令压根进不来',
    MUST_BLOCK.every(([command]) => riskCore.decide(riskCore.classify(command), DEFAULT).action === 'block'),
  )
  check(
    '★ 而用户亲手把某一档设成 allow，就真的听他的（不再偷偷改判）',
    riskCore.decide(riskCore.classify('node -e "console.log(1)"'), LOOSE).action === 'allow',
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
    /* ★ 「需要确认」档才会弹窗（2026-09-29 起 full 档不问）—— 而且这批命令有真实副作用，
       必须走「问完就拒」这条路，绝不能真跑 */
    const result = await tools.execute('run_shell', { command }, { ...denyCtx, permission: 'ask' })
    check(
      `★ ${why}：弹了确认，拒绝后不执行`,
      probe.length > 0 && result.includes('拒绝'),
      `问了 ${probe.length} 次｜${result.slice(0, 80)}`,
    )
  }

  /* ★ 用户报的那个 bug 的回归锁（2026-09-28 真机审计）：选了「完全访问」，一条无害的
     `node -e` 被判高风险 → 照样弹窗。现在：完全访问 = 不问。这条无副作用，可以真跑。 */
  probe.length = 0
  const inlineScript = await tools.execute(
    'run_shell',
    { command: 'node -e "console.log(1)"' },
    { ...denyCtx, permission: 'full' },
  )
  check(
    '★★ 「完全访问」下高风险命令不再弹窗（用户报的就是这条）',
    probe.length === 0 && !inlineScript.includes('拒绝'),
    `问了 ${probe.length} 次｜${inlineScript.slice(0, 80)}`,
  )
  probe.length = 0
  const askedInAskMode = await tools.execute(
    'run_shell',
    { command: 'node -e "console.log(1)"' },
    { ...denyCtx, permission: 'ask' },
  )
  check(
    '★ 而「需要确认」档下同一条命令照旧要问（不能把安全网一起拆了）',
    probe.length === 1 && askedInAskMode.includes('拒绝'),
    `问了 ${probe.length} 次｜${askedInAskMode.slice(0, 60)}`,
  )

  /* `find . -delete` 单独测：目标就是当前目录，`run_shell` 那层的 DANGEROUS 会**直接拒掉**
     （进不到确认那一步）。两种拦法都算合格 —— 要求只有一条：不许未经确认就执行。 */
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
