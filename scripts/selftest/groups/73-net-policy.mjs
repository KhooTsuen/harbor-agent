import { check, group } from '../harness.mjs'
import { configModule, ctx, join, readFileSync, require, ROOT } from '../env.mjs'

/*
   网络策略：把「声明」变成「强制」。钉住的是**语义**（后人最容易改坏的那些）：
     · 点名的联网命令一个不漏；本地命令不被误判
     · 三档模式逐档正确；**认不出的模式当 ask，绝不当 allow**
     · 主机名单 deny 优先于 allow；抠不出主机时只有 mode: deny 拦得住（如实说边界）
     · ★ ctx.networkGrant === 'deny' 时，mode: allow 也必须 deny（技能强制档是钉子）
     · MCP：声明 deny 的联网服务器不启动；纯 stdio 如实标 uncontrolled
     · 读配置失败 → 回落 ask，**不是** allow；describePolicy 那句「管不到什么」不许删

   ⚠️ 这一组**不改用户的 config.json**：策略全走注入（ctx.netPolicy）；
   最后那组只把 configModule.get 临时换成抛错，跑完在 finally 里还原。
   ⚠️ `scripts/selftest.mjs` 还没注册这一组（主代理加一行 import + GROUPS 即可）；
   单独跑的现成命令写在 `tmp-note-a3.md`。
*/

const netPolicy = require(join(ROOT, 'electron/core/net-policy.cjs'))
const guard = require(join(ROOT, 'electron/core/mcp-network-guard.cjs'))
const patterns = require(join(ROOT, 'electron/core/risk-patterns.cjs'))
const runShell = require(join(ROOT, 'electron/core/tools/run_shell.cjs'))
const skillPerms = require(join(ROOT, 'electron/core/skill-permissions.cjs'))

/** 任务书点名的联网命令（Windows + Unix 两边），一条都不许漏 */
const MUST_DETECT = [
  'curl https://example.com/x',
  'wget http://example.com/a.zip',
  'Invoke-WebRequest https://example.com',
  'iwr https://example.com',
  'Invoke-RestMethod https://example.com',
  'irm https://example.com',
  'Start-BitsTransfer -Source https://example.com/a',
  'bitsadmin /transfer j https://example.com/a C:\\a',
  'certutil -urlcache -f https://example.com/a a',
  'nc example.com 80',
  'ncat example.com 80',
  'telnet example.com 23',
  'ssh user@example.com',
  'scp a.txt user@example.com:/tmp/',
  'sftp user@example.com',
  'ftp example.com',
  'git clone https://example.com/r.git',
  'git fetch origin',
  'git pull',
  'git push origin main',
  'git remote update',
  'npm install lodash',
  'pnpm install',
  'yarn add lodash',
  'npx -y some-mcp-server',
  'pip install requests',
  'gh repo list',
  'docker pull alpine',
  'docker push my:tag',
  'aria2c http://example.com/a.iso',
]

/** 这些必须**不算**联网（治漏不能治成误报满天） */
const LOCAL_ONLY = [
  'git status',
  'git log --oneline -5',
  'dir',
  'ls -la',
  'echo hi',
  'npm run build',
  'node server.js',
  'grep -rn foo src',
  'find . -name "*.cjs"',
]

const curl = { kind: 'shell', target: 'curl https://example.com/x' }
/** 只改策略、不碰真 config.json */
const at = (mode, extra = {}) => ({ ...curl, ctx: { netPolicy: { mode, ...extra } } })

export async function run() {
  group('网络策略 / 模式表')

  const missed = MUST_DETECT.filter((command) => !netPolicy.detect(command).network)
  check('★ 任务书点名的联网命令一个都不漏', missed.length === 0, missed.join(' ｜ '))
  const falseHits = LOCAL_ONLY.filter((command) => netPolicy.detect(command).network)
  check('★ 本地命令不许被误判成联网', falseHits.length === 0, falseHits.join(' ｜ '))
  check(
    '★ 模式表复用 risk-patterns 的 NETWORK，不是复制第二份',
    netPolicy.NET_RISK.some((entry) => entry.pattern === patterns.NETWORK),
  )
  check(
    '每条模式表都带 id / label（理由要说人话）',
    netPolicy.NET_RISK.every((e) => e.id && e.label && e.pattern instanceof RegExp),
  )

  group('网络策略 / 主机抠取（不发请求、不解析 DNS）')

  const hosts = netPolicy.detect('curl https://api.foo.com/x').hosts
  check('★ URL 里的主机能抠出来', hosts.includes('api.foo.com'), hosts.join(','))
  check('hosts 是纯字符串（没有 DNS 结果、没有请求）', typeof hosts[0] === 'string')
  check(
    'user@host 抠得出来',
    netPolicy.detect('ssh user@git.example.com').hosts.includes('git.example.com'),
  )
  check(
    'host:端口 抠得出来',
    netPolicy.detect('wget http://a.b.com:8080/x').hosts.includes('a.b.com'),
  )
  check('IPv4 抠得出来', netPolicy.detect('nc 10.0.0.7 443').hosts.includes('10.0.0.7'))
  check('非法 IP 不算主机名', netPolicy.detect('nc 999.1.1.1 80').hosts.length === 0)
  check(
    'UNC 的服务器名抠得出来',
    netPolicy.detect('dir \\\\fileserver\\share').hosts.includes('fileserver'),
  )
  check('file:// 不算联网主机', netPolicy.detect('type file:///c:/a.txt').hosts.length === 0)
  check(
    '没写 scheme 的 host/path 也认（只在命中联网模式表时）',
    netPolicy.detect('curl -s example.com/x').hosts.includes('example.com'),
  )
  check(
    '抠不出主机就空数组，不猜',
    netPolicy.detect('npx -y some-server').hosts.length === 0,
    netPolicy.detect('npx -y some-server').hosts.join(','),
  )

  group('网络策略 / 三档模式')

  check('deny 档 → 拦', netPolicy.decide(at('deny')).action === 'deny')
  check('ask 档 → 先问', netPolicy.decide(at('ask')).action === 'ask')
  check('allow 档 → 放行', netPolicy.decide(at('allow')).action === 'allow')
  check('★ 认不出的模式当 ask（写错绝不放行）', netPolicy.mode('delete') === 'ask')
  check('模式名大小写宽容', netPolicy.mode('ALLOW') === 'allow')
  check(
    '不涉及网络的动作：网络策略不管（全局禁止也不拦 dir）',
    netPolicy.decide({ kind: 'shell', target: 'dir', ctx: { netPolicy: { mode: 'deny' } } })
      .action === 'allow',
  )
  check('mode() 无参读真配置不炸', ['allow', 'ask', 'deny'].includes(netPolicy.mode()))
  check('拒绝理由说清了怎么放行', /放行/.test(netPolicy.decide(at('deny')).reason))
  check('放行理由也是人话', netPolicy.decide(at('allow')).reason.length > 6)

  group('网络策略 / 主机名单（deny 优先于 allow）')

  check(
    '通配符 *.evil.com 命中子域',
    netPolicy.hostVerdict('a.evil.com', { denyHosts: ['*.evil.com'] }) === 'deny',
  )
  check(
    '通配符也命中裸域（少写一个点绕不过去）',
    netPolicy.hostVerdict('evil.com', { denyHosts: ['*.evil.com'] }) === 'deny',
  )
  check(
    '别的域不受影响',
    netPolicy.hostVerdict('a.good.com', { denyHosts: ['*.evil.com'] }) === 'default',
  )
  check(
    '★ deny 优先于 allow：两边都写就是拦',
    netPolicy.hostVerdict('a.evil.com', {
      denyHosts: ['*.evil.com'],
      allowHosts: ['a.evil.com'],
    }) === 'deny',
  )
  check(
    '★ 命令里的主机命中禁止名单 → 拦（哪怕 mode 是 allow）',
    netPolicy.decide({
      kind: 'shell',
      target: 'curl https://a.evil.com/x',
      ctx: { netPolicy: { mode: 'allow', denyHosts: ['*.evil.com'] } },
    }).action === 'deny',
  )
  check(
    '★ 允许名单里的主机 → 放行（ask 档也不问）',
    netPolicy.decide(at('ask', { allowHosts: ['example.com'] })).action === 'allow',
  )
  check(
    '允许名单只覆盖列出来的主机',
    netPolicy.decide({
      ...curl,
      target: 'curl https://other.com/x',
      ctx: { netPolicy: { mode: 'ask', allowHosts: ['example.com'] } },
    }).action === 'ask',
  )
  check(
    '★ 抠不出主机时主机名单管不到 —— 只有 mode: deny 拦得住（如实说边界）',
    netPolicy.decide({
      kind: 'shell',
      target: 'npx -y some-server',
      ctx: { netPolicy: { mode: 'ask', denyHosts: ['*.evil.com'] } },
    }).action === 'ask' &&
      netPolicy.decide({
        kind: 'shell',
        target: 'npx -y some-server',
        ctx: { netPolicy: { mode: 'deny' } },
      }).action === 'deny',
  )

  group('网络策略 / 技能声明是强制档（钉子）')

  const skillDeny = { ...curl, ctx: { netPolicy: { mode: 'allow' }, networkGrant: 'deny', skillName: '抓网页' } }
  const decidedSkill = netPolicy.decide(skillDeny)
  check('★ networkGrant: deny 时 mode: allow 也必须 deny', decidedSkill.action === 'deny')
  check('理由点名了是哪个技能的声明', decidedSkill.reason.includes('抓网页'))
  check('理由说了怎么放行（改 SKILL.md）', /SKILL\.md/.test(decidedSkill.reason))
  check('没声明（null）时不额外收紧', netPolicy.decide({ ...curl, ctx: { netPolicy: { mode: 'ask' }, networkGrant: null } }).action === 'ask')
  check('技能的 network 声明读得出来', skillPerms.networkGrantOf({ permissions: { byKind: { network: 'deny' } } }) === 'deny')
  check('没声明 / 脏值 → null', skillPerms.networkGrantOf(null) === null && skillPerms.networkGrantOf({ permissions: { byKind: { network: 'denny' } } }) === null)
  const permsSrc = readFileSync(join(ROOT, 'electron/core/skill-permissions.cjs'), 'utf8')
  check('★ 注释没把「技能网络声明」说成已经生效（执行点有，但还没触发它的入口）', /没有一处代码给 `ctx\.networkGrant` 赋值/.test(permsSrc))
  check('★ 注释也没把整个 permissions 说成沙箱', /仍然\*\*只能说成「声明，不是强制」/.test(permsSrc))

  group('网络策略 / MCP 启动门')

  const npxServer = { id: 's1', name: 'npx 型', command: 'npx', args: ['-y', 'some-mcp'], enabled: true, network: false }
  const localServer = { id: 's2', name: '本地脚本', command: 'node', args: ['server.js'], enabled: true }
  const urlServer = { id: 's3', name: 'http 型', command: 'node', args: ['x.js'], url: 'https://mcp.example.com/sse', network: 'allow' }
  const allServers = [npxServer, localServer, urlServer]
  /** 只换全局模式、不碰真 config.json */
  const gate = (servers, mode) => guard.guardServers(servers, { netPolicy: { mode } })

  const gated = gate(allServers, 'ask')
  check('★ network:false 的 npx 型 server 被 block', gated.blocked.some((b) => b.id === 's1'), JSON.stringify(gated.blocked))
  check('被拦的理由是人话且说了怎么办', gated.blocked[0].reason.includes('要启动'))
  check('纯 stdio 无联网命令的 server 放行', gated.allowed.some((s) => s.id === 's2'))
  check('★ 纯 stdio 如实标 uncontrolled（不假装管住了）', guard.statusOf(localServer).status === 'uncontrolled')
  check('url 型标 controlled', guard.statusOf(urlServer).status === 'controlled')
  check('声明 deny 的联网 server 标 blocked', guard.statusOf(npxServer).status === 'blocked')
  check('statusOf 都带了 note 说明为什么', allServers.every((s) => guard.statusOf(s).note.length > 8))
  check('没启用的 server 不进任何一队', gate([{ ...localServer, id: 's4', enabled: false }], 'ask').allowed.length === 0)
  check('★ 默认(ask) 下不误拦：用户自己配的联网 server 照常启动（不许升级即静默失效）', gate([{ ...npxServer, network: 'ask' }], 'ask').allowed.length === 1)
  check(
    '★ 但状态如实标 uncontrolled，且 note 说清「这次没能问你」',
    (() => {
      const s = guard.statusOf({ ...npxServer, network: 'ask' })
      return s.status === 'uncontrolled' && s.note.includes('没能问你')
    })(),
    JSON.stringify(guard.statusOf({ ...npxServer, network: 'ask' })),
  )
  check('全局改 allow 后照样放行', gate([{ ...npxServer, network: 'ask' }], 'allow').allowed.length === 1)
  check('★ 全局改 deny 后拦住（显式的全局意图必须兑现）', gate([{ ...npxServer, network: 'ask' }], 'deny').blocked.length === 1)
  check('布尔老形状也认', guard.declarationOf({ network: false }) === 'deny' && guard.declarationOf({ network: true }) === 'allow')
  check('脏 server 不炸', guard.guardServers(null).blocked.length === 0 && guard.statusOf(null).status === 'uncontrolled')

  group('网络策略 / 接进连接池与 run_shell（接线钉子）')

  const mcpSrc = readFileSync(join(ROOT, 'electron/core/mcp.cjs'), 'utf8')
  const mcpOldFields = [/id: conn\.id/, /alive: conn\.alive/, /error: conn\.error/, /toolCount: conn\.tools\.length/, /tools: conn\.tools\.map/]
  check('★ startAll 启动前过了 guardServers', mcpSrc.includes('guardServers('))
  check('★ status() 带上 blockedReason / networkStatus', mcpSrc.includes('blockedReason') && mcpSrc.includes('networkStatus'))
  check('★ 老字段一个没丢', mcpOldFields.every((re) => re.test(mcpSrc)))
  check('★ 策略变了会重启连接池（指纹里带 network）', /s\.network/.test(mcpSrc))

  const shellSrc = readFileSync(join(ROOT, 'electron/core/tools/run_shell.cjs'), 'utf8')
  check('★ run_shell 执行前调了网络策略', shellSrc.includes('networkGuard(command, ctx)'))
  check('★ deny 路径是「不执行 + 抛错」', /if \(networkBlocked\) throw new Error/.test(shellSrc))

  const denyMsg = runShell.networkGuard('curl https://example.com/', { netPolicy: { mode: 'deny' } })
  check('★★ mode=deny：直接拒（连请求都不会发出去）', denyMsg.includes('被网络策略拦下'), denyMsg.slice(0, 80))
  const upperAsks = runShell.networkGuard('curl https://example.com/', { netPolicy: { mode: 'ask' }, shellPolicy: { medium: 'ask', high: 'ask', critical: 'block' } })
  check('★ ask 档 + 上层会问 → 交给上层（不重复拦）', upperAsks === '', upperAsks.slice(0, 80))
  const upperSilent = runShell.networkGuard('curl https://example.com/', { netPolicy: { mode: 'ask' }, shellPolicy: { medium: 'allow', high: 'allow', critical: 'allow' } })
  check('★★ 上层会静默放行时 → 这一层必须拦（否则没人被问就把请求发出去了）', upperSilent.includes('没人被问'), upperSilent.slice(0, 80))
  /* workdir 显式给 ROOT：这一组不建沙箱（沙箱目录和别的组抢） */
  const echoed = await runShell.run({ command: 'echo net-policy-ok' }, { ...ctx, workdir: ROOT, netPolicy: { mode: 'deny' } })
  check('不涉及网络的命令照旧能跑（别误伤）', echoed.includes('net-policy-ok'), echoed.slice(0, 60))

  group('网络策略 / 读配置失败不能变成放行')

  check('★ describePolicy 如实写了「管不到什么」（诚实性钉子，别删）', netPolicy.describePolicy().includes('管不到'))
  check('describePolicy 带上当前模式', netPolicy.describePolicy({ netPolicy: { mode: 'deny' } }).includes('禁止'))
  check('describePolicy 列出名单', netPolicy.describePolicy({ netPolicy: { denyHosts: ['*.evil.com'] } }).includes('evil.com'))

  const original = configModule.get
  try {
    configModule.get = () => {
      throw new Error('模拟 config.cjs 读失败')
    }
    check('★ mode() 回落到 ask，**不是** allow', netPolicy.mode() === 'ask', netPolicy.mode())
    check('★ 读不到配置时 decide 也按 ask 处理', netPolicy.decide({ kind: 'shell', target: 'curl https://example.com/' }).action === 'ask')
    check('★ describePolicy 在配置坏掉时照样给得出「管不到」', netPolicy.describePolicy().includes('管不到'))
  } finally {
    configModule.get = original
  }
}
