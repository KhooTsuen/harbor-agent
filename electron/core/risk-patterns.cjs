/**
 * Shell 风险分级用的**模式表**（纯数据 + 一个只读判定）
 *
 * 从 `risk.cjs` 拆出来的：那边只留 `classify` / `decide` / `describe` 的逻辑，
 * 这边只管「什么样子算哪一类」。
 *
 * 拆的理由很实际 —— 2026-09-23 补 PowerShell 模式时两件事挤在一个文件里直接顶到
 * 300 行红线，而这张表**还要继续长**（穷举不完的就是它）。
 *
 * ⚠️ 这是**启发式**，一定漏。判错的代价不对称：
 *   · 把只读的判成中风险 → 用户多点一次「允许」，烦一下
 *   · 把破坏性的判成低风险 → **静默执行、无法挽回**
 * 所以拿不准就往上判，别往下判。
 *
 * 为什么要分四级而不是一张黑名单 —— 见 `risk.cjs` 开头那段。
 */

/* ── critical：默认禁止 ───────────────────────────────────── */

const CRITICAL = [
  [/\bformat\s+[a-z]:/i, '格式化磁盘'],
  [/\bmkfs(\.\w+)?\b/i, '格式化文件系统'],
  [/\bdiskpart\b/i, '磁盘分区工具'],
  [/\bdd\s+.*of=\/dev\/(sd|nvme|hd)/i, '直接写裸设备'],
  [/\bcipher\s+\/w/i, '擦除磁盘空闲空间'],
  [/\bvssadmin\s+delete\s+shadows/i, '删除卷影副本（备份）'],
  [/\bwbadmin\s+delete\s+(catalog|systemstatebackup)/i, '删除系统备份'],
  [/\bbcdedit\b.*\b(delete|set)\b/i, '修改启动配置'],
  /*
   * ★ 关机 / 重启。原来这条写成 `\b(shutdown|Restart-Computer)\b.*\/(-r|-s|-f)`，
   *   要求参数带**斜杠** —— 那是 cmd 的写法，PowerShell 用的是 `-Force`，
   *   于是 `Stop-Computer -Force` / `Restart-Computer -Force` 一条都拦不到（实测判成 medium）。
   */
  [/\b(shutdown|Stop-Computer|Restart-Computer)\b/i, '关机或重启系统'],
  [/:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, 'fork 炸弹'],
  [/\breg\s+(delete|save)\s+HKLM[\\/]/i, '删改注册表 HKLM 或导出 hive'],
  [/\b(procdump|mimikatz)\b/i, '内存转储 / 凭据抓取工具'],
  [/\blsass(\.exe)?\b/i, '访问 LSASS 进程'],
  [/\bset-mppreference\b.*-disablerealtimemonitoring/i, '关闭 Defender 实时保护'],
  [/\bnetsh\s+advfirewall\s+set\s+\S+\s+state\s+off/i, '关闭防火墙'],
  [/\bwevtutil\s+(cl|clear-log)/i, '清空系统日志'],
  [/\bcacls\b|\bicacls\b.*\/grant\s+(everyone|users)/i, '改系统目录权限'],

  /* ── ↓ 2026-09-23 补：全部是 PowerShell / 脚本写法，原来一条都没覆盖 ↓ ── */

  [
    /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|Set-Disk|Resize-Partition|Repair-Volume)\b/i,
    '格式化或重分区磁盘（PowerShell）',
  ],
  [/\bmountvol\s+\S*\s*\/d\b/i, '删除驱动器挂载点'],
  /* 账户操作：加一个管理员账户 = 拿下整台机器，没有任何「agent 顺手做一下」的正当场景 */
  [/\bnet\s+user\s+\S+\s+[^\n]*\/add\b/i, '创建系统账户'],
  [/\bnet\s+user\s+\S+\s+[^\n]*\/(delete|active:no)\b/i, '删除或停用系统账户'],
  [/\bnet\s+(localgroup|group)\s+\S+\s+[^\n]*\/add\b/i, '把账户加进组（可能提权）'],
  [
    /\b(New-LocalUser|Add-LocalGroupMember|Set-LocalUser|Remove-LocalUser|Enable-LocalUser)\b/i,
    '创建或改动本地账户',
  ],
  /*
   * 脚本里直接删盘根。参数是变量就看不见了，所以只能抓**写死**的这种 ——
   * `shutil.rmtree('E:/')`、`fs.rmSync('C:\\', {recursive:true})` 都归这里。
   */
  [
    /\b(rmtree|rmSync|rmdirSync|delTree)\s*\(\s*['"]([a-zA-Z]:[\\/]?|\/|[\\/]{2})['"]/i,
    '脚本删除整个盘或根目录',
  ],
  /*
   * PowerShell 递归删盘根：`Remove-Item -Recurse ./build` 是 high（要确认），
   * 但目标是盘根（`C:\` / `/`）和 `rm -rf /` 是同一件事 —— 没有正当场景，直接 critical。
   */
  [
    /\bRemove-Item\b[^\n]*-Recurse\b[^\n]+\s(['"]?[a-zA-Z]:[\\/]?['"]?|\\{1,2}|\/)\s*$/i,
    '递归删除整个盘或根目录（PowerShell）',
  ],
  [
    /\bRemove-Item\b[^\n]*-(?:Path|LiteralPath)\s+['"]?[a-zA-Z]:[\\/]?['"]?[^\n]*-Recurse\b/i,
    '递归删除整个盘或根目录（PowerShell）',
  ],
  /* dd 往盘上写：`of=/dev/` 那条是 Unix 裸设备，这条补 Windows 盘符 */
  [/\bdd\s+if=.*of=[a-z]:[\\/]/i, '用 dd 覆盖盘上的文件'],
  /* WMIC 删卷/格式化 —— 这是删盘，不是「改系统」，从 high 提到 critical */
  [/\bwmic\b[^\n]*\b(delete|format)\b/i, '用 WMIC 删除卷或格式化磁盘'],
]

/* ── high：必须确认（即使用户选了完全访问）───────────────── */

const HIGH = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, '递归强制删除'],
  [/\b(del|erase)\s+\/[sf]\b/i, '强制删除文件'],
  [/\b(rmdir|rd)\s+\/s\b/i, '递归删目录'],
  [/\bRemove-Item\b.*-Recurse/i, '递归删除（PowerShell）'],
  [/\bgit\s+push\b.*(--force|-f)\b/i, '强制推送（会覆盖远端历史）'],
  [/\bgit\s+reset\s+--hard\b/i, '丢弃本地改动'],
  [/\bgit\s+clean\s+-[a-z]*f/i, '删除未跟踪文件'],
  [/\bgit\s+(checkout|restore)\s+\.\s*$/, '撤销工作区所有改动'],
  [/\breg\s+(add|import|delete)\b/i, '修改注册表'],
  [/\b(sc|net)\s+(config|stop|start|delete)\b/i, '改动系统服务'],
  [/\bNew-Service\b|\bSet-Service\b|\b(Stop|Suspend|Resume)-Service\b/i, '创建或改动服务'],
  [/\bschtasks\s+\/create\b/i, '创建计划任务'],
  [/\b(Invoke-Expression|iex)\b/i, '动态执行字符串（内容看不见）'],
  [/\s-(enc|encodedcommand)\s+[A-Za-z0-9+/=]{8,}/i, 'Base64 编码命令（内容不可见）'],
  [
    /\b(curl|wget|Invoke-WebRequest|iwr)\b[^\n]*\|[^\n]*\b(sh|bash|pwsh|powershell|cmd|iex)\b/i,
    '下载后直接执行',
  ],
  [/\bcertutil\b[^\n]*-urlcache/i, '用 certutil 下载文件'],
  [
    /\b(cmd|powershell|pwsh)\s+\/[cK]\s+.*\b(curl|wget|Invoke-WebRequest)\b/i,
    'shell 里嵌套下载命令',
  ],
  [/\bnpx\b/i, '临时下载并运行一个包'],
  [/\b(npm|pnpm|yarn)\s+(install|i|add)\b[^\n]*(-g|--global)\b/i, '全局安装包'],
  [/\bpip\s+install\b[^\n]*(--user|--target)\b/i, '安装 Python 包到用户目录'],
  [/\b(choco|winget|scoop)\s+install\b/i, '用包管理器安装系统软件'],
  [/\b(runas|Start-Process\b.*-Verb\s+RunAs)\b/i, '以管理员身份运行'],
  [/\bsudo\b/i, '提权执行'],
  [/\bbase64\s+(-d|--decode)\b[^\n]*\|/i, 'Base64 解码后接管道（可能藏命令）'],
  [
    /\b(find|dir|ls)\b[^\n]*(\.ssh|\.aws|Cookies|Login Data|credentials)[^\n]*(\||>|$)/i,
    '搜索凭据类文件',
  ],
  [/\bprivacy\b|\bTrash\b/i, '可能的破坏性工具'],
  [/\bnpm\s+publish\b/i, '发布包（对外可见）'],
  [/\bdocker\s+(rm|rmi|system\s+prune)\b[^\n]*(-f|--force)/i, '强制删除容器或镜像'],
  [/\b(git|npm|pnpm)\b[^\n]*\bconfig\b[^\n]*(--global|--system)/i, '改全局配置'],

  /* ── ↓ 2026-09-23 补 ↓ ── */

  /*
   * 内联脚本。原来这三条在 OPAQUE 里（只升到 medium），但 **medium 可以被配置成静默放行**，
   * 而"代码在参数里、用户看不见"这件事和 `iex`（上面那条 high）是**同一类** ——
   * `python -c "shutil.rmtree('E:/')"` 实测判成 medium、零确认。同一类行为两个等级，
   * 本身就是不一致，所以提到 high。
   */
  [/\b(python|python3|py)\b[^\n]*\s-c\b/i, '内联脚本（代码在参数里，看不见）'],
  [/\bnode\b[^\n]*\s(-e|--eval)\b/i, '内联脚本（代码在参数里，看不见）'],
  [/\b(perl|ruby|php)\b[^\n]*\s(-e|-r)\b/i, '内联脚本（代码在参数里，看不见）'],
  /*
   * ★ `find . -delete` / `find . -exec rm {} +`。
   *   实测（2026-09-23）**被判成 low 且静默执行** —— `find` 在只读白名单里，
   *   而白名单原来只看命令开头对不对，后面跟什么压根不看。
   */
  [/\bfind\b[^\n]*\s-(delete|exec|execdir|ok)\b/i, 'find 边搜边删或边执行'],
  [/\bschtasks\s+\/(delete|change|end|run)\b/i, '改动或立即执行计划任务'],
  [
    /\b(Register-ScheduledTask|New-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask)\b/i,
    '创建或改动计划任务',
  ],
  [/\bmsiexec\b[^\n]*\/i\b/i, '静默安装 msi 包'],
  [/\b(takeown|Set-Acl)\b/i, '夺取文件所有权或改 ACL'],
  [/\bSet-ExecutionPolicy\b/i, '改执行策略（等于放开脚本执行）'],
  [/\bwmic\b[^\n]*\bcall\b/i, '用 WMIC 调用方法'],
  [/\b(New-SmbShare|Remove-SmbShare|Grant-SmbShareAccess)\b/i, '改动网络共享'],
]

/* ── medium：写操作 / 构建 / 网络 ─────────────────────────── */

const MEDIUM = [
  [/\b(npm|pnpm|yarn)\s+(install|i|ci|add|remove|uninstall|update)\b/i, '安装或卸载依赖'],
  [/\bpip\s+(install|uninstall)\b/i, '安装或卸载 Python 包'],
  [/\bcargo\s+(install|add|remove)\b/i, '改动 Rust 依赖'],
  [/\bgo\s+(get|install)\b/i, '安装 Go 包'],
  [/\b(npm|pnpm|yarn)\s+(run|test|build|start)\b/i, '跑项目脚本（内容由 package.json 决定）'],
  [/\b(make|cmake|ninja|msbuild|dotnet\s+build)\b/i, '构建'],
  [
    /\bgit\s+(commit|merge|rebase|stash|cherry-pick|tag|branch\s+-[dD]|checkout|switch|pull|fetch)\b/i,
    '改动 Git 状态',
  ],
  [/\bgit\s+(clone)\b/i, '从网络克隆仓库'],
  [/\b(curl|wget|Invoke-WebRequest|iwr)\b/i, '网络请求'],
  [/\b(ssh|scp|sftp|rsync)\b/i, '远程连接'],
  [/\bdocker\b|\bdocker-compose\b/i, 'Docker 命令'],
  [
    /\b(Move-Item|Copy-Item|New-Item|Set-Content|Add-Content|Out-File|New-ItemProperty)\b/i,
    '文件写入（PowerShell）',
  ],
  [/\b(mkdir|md|copy|xcopy|move|ren|mklink)\b/i, '文件系统操作'],
  [/>>?\s*[^\s|&]+/, '输出重定向（会写文件）'],
  [/\bchmod\b|\bchown\b|\battrib\b|\bicacls\b/i, '改文件权限'],
  [/\btaskkill\b|\bStop-Process\b|\bkill\b/i, '结束进程'],
]

/* ── low：只读查询 ────────────────────────────────────────── */

/*
 * ⚠️ 这些正则只匹配**命令开头**。原来只要开头对得上就整条按只读放行 ——
 * 实测 `find . -delete` 因此被判成 low 并静默执行。
 * 现在必须配 `isReadOnlyCommand()` 一起用：光开头对不算，整条都得像只读。
 */
const LOW = [
  /^\s*(pwd|cd|ls|dir|tree|cat|type|head|tail|more|less|wc|find|findstr|grep|rg)\b/i,
  /^\s*(echo|printf|whoami|hostname|date|time|ver|uname|env|set)\s*$/i,
  /^\s*git\s+(status|diff|log|show|branch|remote|describe|rev-parse|ls-files|blame)\b/i,
  /^\s*(node|npm|python|python3|pip|go|rustc|cargo|java|dotnet|tsc|git)\s+(-v|--version|version)\b/i,
  /^\s*(where|which|command -v|type)\b/i,
  /^\s*(Get-ChildItem|Get-Content|Select-String|Test-Path|Get-Item|Get-Command)\b/i,
  /^\s*(npm|pnpm|yarn)\s+(ls|list|outdated|why|view)\b/i,
]

/** 会让「这条命令到底干了什么」变得不可见的写法（拼命令 / 嵌套 / 命令替换） */
const OPAQUE = [
  [/&&|\|\|?|;/, '多条命令串联或管道（后面那些不会单独确认）'],
  [/\bpowershell\b|\bpwsh\b|\bcmd\b\s*\/c/i, '嵌套一层 shell'],
  [/\$\s*\(|`[^`]+`/, '命令替换（内层先执行，用户看不到）'],
]

/** 下载/网络关键词 —— 只有它一个的时候算「网络取数据」，不算执行 */
const NETWORK =
  /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|ssh|scp|sftp|rsync|git\s+(clone|pull|fetch|push)|npm\s+(install|publish)|pip\s+install)\b/i

const WRITES =
  /(\brm\b|\bdel\b|\brmdir\b|\bRemove-Item\b|\bmove\b|\bcopy\b|\bSet-Content\b|>>?|\bmkdir\b|\bgit\s+(commit|push|reset|clean|checkout|rebase|merge)\b|\bnpm\s+(install|i|ci|add)\b|\bmake\b|\bcargo\s+build\b)/i

/* ── 只读判定 ─────────────────────────────────────────────── */

/** shell 元字符：能拼命令、能重定向、能取变量 —— 出现就不敢再当只读 */
const SHELL_META = /[|&;<>`$]/

/**
 * 这些参数一出现，「只读命令」就不只读了。
 * 故意只收**含义明确**的 —— `-r` / `-f` / `-n` 这种同名不同义的绝不能进来
 * （`grep -r`、`ls -f`、`find -name` 都是好东西，误报会让人干脆关掉整个分级）。
 */
const MUTATING_ARG = /^(-delete|--delete|-exec|-execdir|-exec-batch|-ok|-fls|-fls0|-fprint|--remove|--no-preserve-root)$/i

/**
 * 整条命令是不是「只读形状」：开头是只读命令 + 没有 shell 元字符 + 参数里不带破坏性开关。
 * @param {string} text
 */
function isReadOnlyCommand(text) {
  if (!LOW.some((pattern) => pattern.test(text))) return false
  if (SHELL_META.test(text)) return false
  return !text
    .trim()
    .split(/\s+/)
    .some((token) => MUTATING_ARG.test(token))
}

module.exports = {
  CRITICAL,
  HIGH,
  MEDIUM,
  LOW,
  OPAQUE,
  NETWORK,
  WRITES,
  MUTATING_ARG,
  SHELL_META,
  isReadOnlyCommand,
}
