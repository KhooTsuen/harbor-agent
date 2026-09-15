/**
 * Shell 风险分级
 *
 * **这不是沙箱，这是「把话说明白」的那一层。**
 *
 * 原来只有一张危险命令黑名单（11 条正则），拦不住的太多了：
 * PowerShell / python / node / .bat / .ps1 / .vbs、下载后执行、
 * base64 解码执行、间接调系统工具、环境变量窃取、命令替换、管道……
 * 靠穷举命令名永远补不完。
 *
 * 所以换个思路：**不判断「这条命令危不危险」，判断「它属于哪一类行为」**，
 * 再按类别给策略。分类是启发式的（也会漏），但每一类都有明确的人工确认点，
 * 而且**理由会显示给用户**——用户看到的不是「被拦了」，而是
 * 「这条命令会改注册表」。
 *
 * 四个等级：
 *   low      只读查询（pwd / ls / git status）
 *   medium   构建、装依赖、改文件、网络取数据
 *   high     递归删除、改系统配置、提权、下载后执行、强推
 *   critical 格式化磁盘、破坏系统、抓凭据、关杀软 —— **默认直接拦**
 */

/** 从低到高 */
const LEVELS = ['low', 'medium', 'high', 'critical']

const rank = (level) => LEVELS.indexOf(level)

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
  [/\b(shutdown|Restart-Computer)\b.*\/(-r|-s|-f)/i, '关机或重启系统'],
  [/:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, 'fork 炸弹'],
  [/\breg\s+(delete|save)\s+HKLM[\\/]/i, '删改注册表 HKLM 或导出 hive'],
  [/\b(procdump|mimikatz)\b/i, '内存转储 / 凭据抓取工具'],
  [/\blsass(\.exe)?\b/i, '访问 LSASS 进程'],
  [/\bset-mppreference\b.*-disablerealtimemonitoring/i, '关闭 Defender 实时保护'],
  [/\bnetsh\s+advfirewall\s+set\s+\S+\s+state\s+off/i, '关闭防火墙'],
  [/\bwevtutil\s+(cl|clear-log)/i, '清空系统日志'],
  [/\bcacls\b|\bicacls\b.*\/grant\s+(everyone|users)/i, '改系统目录权限'],
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
  [/\bNew-Service\b|\bSet-Service\b/i, '创建或改动服务'],
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

const LOW = [
  /^\s*(pwd|cd|ls|dir|tree|cat|type|head|tail|more|less|wc|find|findstr|grep|rg)\b/i,
  /^\s*(echo|printf|whoami|hostname|date|time|ver|uname|env|set)\s*$/i,
  /^\s*git\s+(status|diff|log|show|branch|remote|describe|rev-parse|ls-files|blame)\b/i,
  /^\s*(node|npm|python|python3|pip|go|rustc|cargo|java|dotnet|tsc|git)\s+(-v|--version|version)\b/i,
  /^\s*(where|which|command -v|type)\b/i,
  /^\s*(Get-ChildItem|Get-Content|Select-String|Test-Path|Get-Item|Get-Command)\b/i,
  /^\s*(npm|pnpm|yarn)\s+(ls|list|outdated|why|view)\b/i,
]

/** 会让「这条命令到底干了什么」变得不可见的写法 */
const OPAQUE = [
  [/&&|\|\|?|;/, '多条命令串联或管道（后面那些不会单独确认）'],
  [/\bpowershell\b|\bpwsh\b|\bcmd\b\s*\/c/i, '嵌套一层 shell'],
  [/\$\s*\(|`[^`]+`/, '命令替换（内层先执行，用户看不到）'],
  [
    /\bpython\b[^\n]*-c\b|\bnode\b[^\n]*-e\b|\bperl\b[^\n]*-e\b|\bruby\b[^\n]*-e\b/i,
    '内联脚本（代码不在命令里显式可见）',
  ],
]

/** 下载/网络关键词 —— 只有它一个的时候算「网络取数据」，不算执行 */
const NETWORK =
  /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|ssh|scp|sftp|rsync|git\s+(clone|pull|fetch|push)|npm\s+(install|publish)|pip\s+install)\b/i

const WRITES =
  /(\brm\b|\bdel\b|\brmdir\b|\bRemove-Item\b|\bmove\b|\bcopy\b|\bSet-Content\b|>>?|\bmkdir\b|\bgit\s+(commit|push|reset|clean|checkout|rebase|merge)\b|\bnpm\s+(install|i|ci|add)\b|\bmake\b|\bcargo\s+build\b)/i

/**
 * 给一条命令定级。
 *
 * @param {string} command
 * @returns {{ level: 'low'|'medium'|'high'|'critical', reasons: string[], network: boolean, writes: boolean, installs: boolean, elevation: boolean, opaque: string[] }}
 */
function classify(command) {
  const text = String(command ?? '').trim()
  const reasons = []
  const opaque = []
  let level = 'low'

  const bump = (next) => {
    if (rank(next) > rank(level)) level = next
  }

  /* critical 优先 —— 命中就是命中 */
  for (const [pattern, label] of CRITICAL) {
    if (pattern.test(text)) {
      reasons.push(label)
      bump('critical')
    }
  }

  for (const [pattern, label] of HIGH) {
    if (pattern.test(text)) {
      reasons.push(label)
      bump('high')
    }
  }

  for (const [pattern, label] of MEDIUM) {
    if (pattern.test(text)) {
      reasons.push(label)
      bump('medium')
    }
  }

  for (const [pattern, label] of OPAQUE) {
    if (pattern.test(text)) opaque.push(label)
  }
  /* 拼接/嵌套/内联脚本：即使单看每条都是只读，整体也按中风险处理 */
  if (opaque.length > 0) {
    reasons.push(...opaque)
    bump('medium')
  }

  /* 一条都不命中：可能是没见过的只读命令，也可能是没见过的写命令。
     只读白名单命中就放心，否则保守给 medium。 */
  const known = LOW.some((pattern) => pattern.test(text))
  if (!known && reasons.length === 0) {
    reasons.push('没有匹配到已知的只读命令')
    bump('medium')
  }

  const network = NETWORK.test(text)
  const writes = WRITES.test(text)
  const installs =
    /\b(npm|pnpm|yarn)\s+(install|i|ci|add)\b|\bpip\s+install\b|\b(cargo|go)\s+(install|get)\b|\b(choco|winget|scoop)\s+install\b/i.test(
      text,
    )
  const elevation = /\b(runas|sudo)\b|\b-verb\s+runas\b|\bstart-process\b[^\n]*-verb\s+runas/i.test(
    text,
  )

  return {
    level,
    reasons: [...new Set(reasons)].slice(0, 5),
    network,
    writes,
    installs,
    elevation,
    opaque,
    command: text.slice(0, 400),
  }
}

/**
 * 按配置策略裁决：'allow' | 'ask' | 'block'
 *
 * @param {object} verdict classify() 的结果
 * @param {{ medium: string, high: string, critical: string }} policy
 */
function decide(verdict, policy) {
  const fallback = { low: 'allow', medium: 'ask', high: 'ask', critical: 'block' }
  const action =
    verdict.level === 'low' ? 'allow' : (policy?.[verdict.level] ?? fallback[verdict.level])

  /* 提到权限提升/磁盘级破坏时，无论策略怎么配都要拦 —— 这几类没有「默默允许」的正当场景 */
  if (verdict.level === 'critical' && action !== 'block') {
    return { action: 'ask', forced: true, note: '这类操作默认不静默放行' }
  }
  return { action }
}

/** 给用户看的一句话 */
function describe(verdict) {
  const label = { low: '低风险', medium: '中风险', high: '高风险', critical: '危险' }[verdict.level]
  const extra = verdict.reasons.length > 0 ? ` — ${verdict.reasons.join('；')}` : ''
  return `${label}${extra}`
}

module.exports = { LEVELS, classify, decide, describe, rank }
