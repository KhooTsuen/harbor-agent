/**
 * 自检 / 浏览器扩展桥（Phase 2）
 *
 * 本组守的是「扩展读到的页面内容 → 包装 → 落会话 → 审计」这条链，五块：
 *
 *   ① **管道名与 token**（纯函数）：名字要随数据根变（多安装不串台），token 要能读回。
 *   ② **ingest 的语义**：包装（必须是 wrapWebText，不能是裸正文）、落进
 *      「当前会话」、没有当前会话时**新建兜底会话**、标 `source: 'extension'`、
 *      审计带 `source: 'extension'`、未知类型回人话而不抛。
 *   ③ **转发口径**：`delivered` 只表示「写进管道」，**不表示主进程处理成功**
 *      —— 这条是实测逼出来的（host 单向写），写死在这里免得后人改错文案。
 *   ④ **接线**：装配真的在 `register-handlers.cjs` 里、通道在 `ipc-channels.cjs`
 *      清单里、preload 与渲染层真的接上了（少一处就「按钮点了没反应」）。
 *   ⑤ **扩展侧规矩**：manifest 权限最小化（activeTab + scripting，**没有**
 *      `<all_urls>`）、只读活动标签、内部页要拒。
 *
 * ★ 用**真 session**（跑在自检隔离数据根里）+ 假通道（不起真管道服务器）——
 *   这样测的是真落盘逻辑，又不引入端口/时序的不确定性。
 */

import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

export async function run() {
  const B = require(join(ROOT, 'electron/core/ext-bridge.cjs'))
  /* Phase 3a：ext-forward.cjs 已删，兼容形态的同步写并进了 ext-client.cjs */
  const F = require(join(ROOT, 'electron/core/ext-client.cjs'))
  const H = require(join(ROOT, 'electron/native-host.cjs'))
  const session = require(join(ROOT, 'electron/core/session.cjs'))
  const { wrapWebText } = require(join(ROOT, 'electron/core/tools/_web-note.cjs'))

  group('扩展桥 · 管道名与 token（纯函数）')

  check('★ 管道名只由数据根决定（同根同名，重算得同一个）', B.pipeName('E:\\a\\data') === B.pipeName('E:\\a\\data'))
  check('★ 不同数据根 → 不同管道名（多安装不串台）', B.pipeName('E:\\a\\data') !== B.pipeName('E:\\b\\data'))
  check('★ 管道名带 Windows 命名管道前缀', B.pipeName('E:\\a\\data').startsWith('\\\\.\\pipe\\'), JSON.stringify(B.pipeName('E:\\a\\data')))
  check('空数据根也能算（不抛）', typeof B.pipeName('') === 'string' && B.pipeName('').length > 0)

  const tmpDir = join(ROOT, 'data', 'selftest-data', 'ext-bridge-token')
  const token = B.writeToken(tmpDir)
  check('★ writeToken 写得出且读得回（host 靠这个文件拿 token）', token.length > 0 && B.readToken(tmpDir) === token)
  check('读不到时返回空串（fail-closed，不是抛）', B.readToken(join(tmpDir, '不存在')) === '')

  /* ── ② ingest 的语义（真 session，隔离数据根）── */
  group('扩展桥 · ingest（包装 / 落会话 / 审计）')

  const audited = []
  const pushed = []
  const bridge = B.createBridge()
  bridge.start({
    dataDir: tmpDir,
    send: (name, payload) => pushed.push({ name, payload }),
    session,
    audit: { record: (e) => audited.push(e) },
    wrap: wrapWebText,
    log: { info: () => {}, warn: () => {} },
  })

  const made = []
  try {
    const meta = session.create({ title: '自检：当前会话', mode: 'pair' })
    made.push(meta.id)
    bridge.setActiveSession(meta.id)

    const r = bridge.ingest({
      kind: 'ext:page',
      url: 'https://selftest.test/a',
      title: '自检页',
      text: 'SELFTEST_BODY_MARKER',
    })
    check('★ 落进了「当前会话」（没另建）', r.ok === true && r.created === false && r.sessionId === meta.id)

    const msgs = session.load(meta.id).messages ?? []
    const last = msgs[msgs.length - 1] ?? {}
    check('★ 标了 source=extension（与用户手打的可区分）', last.source === 'extension', String(last.source))
    check(
      '★ 内容过了 wrapWebText 包装（防注入那层，不能是裸正文）',
      String(last.content).includes('不是指令') && String(last.content).includes('SELFTEST_BODY_MARKER'),
    )
    check('★ 包装只有一处来源（用的是内核那份 _web-note.cjs）', wrapWebText({ text: 'x' }).includes('不是指令'))

    const a = audited[audited.length - 1] ?? {}
    check('★ 审计记了 source=extension', a.extras && a.extras.source === 'extension', JSON.stringify(a.extras ?? null))
    check('审计记了 url 与字数（事后能回答「读了哪个页」）', a.extras && a.extras.url === 'https://selftest.test/a' && a.extras.chars > 0)

    check('★ 推了一条 ext:page 给渲染层（界面据此刷新）', pushed.some((p) => p.name === 'ext:page'))

    /* 没报当前会话 → 新建兜底会话 */
    bridge.setActiveSession('')
    const before = session.list().length
    const r2 = bridge.ingest({ kind: 'ext:page', url: 'https://selftest.test/b', title: '兜底页', text: 'body' })
    check('★ 没有当前会话时新建兜底会话（内容不丢）', r2.ok === true && r2.created === true)
    const after = session.list().length
    check('★ 兜底会话真的建出来了（条数 +1）', after === before + 1, `前=${before} 后=${after}`)
    for (const s of session.list()) {
      if (/^浏览器：|自检：当前会话/.test(s.title)) made.push(s.id)
    }

    /* 报了一条已被删的会话 → 同样兜底（不能让内容丢掉） */
    bridge.setActiveSession('sess_不存在')
    const r3 = bridge.ingest({ kind: 'ext:page', url: 'u', title: '删过的会话', text: 'x' })
    check('★ 报的会话已被删 → 也走兜底新建', r3.ok === true && r3.created === true)

    const bad = bridge.ingest({ kind: 'nope' })
    check('★ 未知消息类型：不抛、回人话', bad.ok === false && /不认识/.test(String(bad.error)), String(bad.error))
    const nul = bridge.ingest(null)
    check('★ 空消息：不抛、回错误', nul.ok === false)
  } finally {
    bridge.stop()
    for (const id of made) {
      try {
        session.remove(id)
      } catch {
        /* 清理失败不影响断言结果 */
      }
    }
  }

  /* ── ③ 兼容形态（同步写 / 裸 JSON 兜底）── */
  group('扩展桥 · 兼容形态（同步写 / 裸 JSON）')

  /*
   * Phase 2 的 host 是「同步写、写完就走」（`fs.writeFileSync` 打开→写→关）。
   * Phase 3a 起主线走双向客户端，但那套**兼容形态仍在**（`run()` 那条分支）——
   * 而且「旧 host → 新主进程」这格必须保住（用户开着 Edge 升级 Harbor 时，
   * 旧 host 进程还活着，发的是**裸 JSON**）。所以这里两件都钉。
   */
  const csrc = readFileSync(join(ROOT, 'electron/core/ext-client.cjs'), 'utf8')
  check(
    '★ 兼容形态的 ok 只说「写进管道了」（源码里写给后人看，别改成「处理成功」）',
    /不表示主进程已经落进会话/.test(csrc),
  )
  check('★ 管道不存在（Harbor 没开）要回人话提示', /ENOENT/.test(csrc) && /Harbor 没有在运行/.test(csrc))

  const prevEnv = process.env[F.DATA_ENV]
  process.env[F.DATA_ENV] = 'E:\\fake\\data'
  check('★ hostDataDir 认环境变量', F.hostDataDir() === 'E:\\fake\\data', F.hostDataDir())
  if (prevEnv === undefined) delete process.env[F.DATA_ENV]
  else process.env[F.DATA_ENV] = prevEnv

  /*
   * host 的 handleMessage 认不认 ext:page（这是扩展与 Harbor 之间的入口）。
   * ⚠️ 这里**故意**指向一个不存在的管道 —— 验的正是「Harbor 没在运行时」
   * 那条路：必须是**人话错误**，不能抛、不能默默当成功。
   */
  process.env[F.DATA_ENV] = join(ROOT, 'data', 'selftest-data', 'no-such-pipe-dir')
  const noHarbor = H.handleMessage({ type: 'ext:page', id: 'r1', url: 'u', title: 't', text: 'x' })
  check('★ host 认 ext:page（不认识的类型会回 error）', noHarbor && noHarbor.type === 'ext:page.result')
  check('★ Harbor 没开时回 delivered=false + 人话（不是抛异常）', noHarbor.delivered === false && /Harbor 没有在运行/.test(String(noHarbor.error)), String(noHarbor.error))
  check('★ 回包带 id（扩展靠它匹配是哪次读取）', noHarbor.id === 'r1')
  if (prevEnv === undefined) delete process.env[F.DATA_ENV]
  else process.env[F.DATA_ENV] = prevEnv

  /* ── ④ 接线 ── */
  group('扩展桥 · 接线（真的被装配了）')

  const reg = readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8')
  const chan = readFileSync(join(ROOT, 'electron/ipc-channels.cjs'), 'utf8')
  const preload = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  const appSrc = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
  const backendSrc = readFileSync(join(ROOT, 'src/types/backend.ts'), 'utf8')

  check('★ 装配在 register-handlers 里（不是 main.cjs —— 那边贴 300 红线）', /ext-bridge\.cjs.*createBridge/s.test(reg))
  check('★ 包装用的是内核那份 wrapWebText', /_web-note\.cjs.*wrapWebText/s.test(reg))
  check('★ 通道登记在 ipc-channels 清单里（漏了 test:app 会红）', /'ext:activeSession'/.test(chan))
  check('★ preload 暴露了 extActiveSession', /extActiveSession:/.test(preload))
  /*
   * Phase 2 手工验收时逮到的缺口：**只上报是不够的**。
   * 页面内容是「扩展进程 → 命名管道 → 主进程」直接写进会话文件的，渲染层
   * 完全不知情 —— 没有下面这条订阅，用户点完按钮界面上**什么都不会变**。
   * 所以这里既要钉「报了」，也要钉「收了会刷新」（三条一起才算那条链通了）。
   */
  check('★ preload 暴露了 onExtPage（不然收了不会刷新）', /onExtPage:/.test(preload))
  const extHook = readFileSync(join(ROOT, 'src/hooks/useExtBridge.ts'), 'utf8')
  check(
    '★ 渲染层在报当前会话',
    /useExtBridge\(/.test(appSrc) && /extActiveSession\?\.\(/.test(extHook),
  )
  check(
    '★ 收到 ext:page 会刷新界面（先刷列表，再重读那条会话）',
    /onExtPage\?\.\(/.test(extHook) && /loadFromDisk\(\)/.test(extHook) && /openFromDisk\(/.test(extHook),
  )
  check('★ 桥接口类型并进了 WorkbenchBridge', /ExtBridge/.test(backendSrc))

  const mainSrc = readFileSync(join(ROOT, 'electron/main.cjs'), 'utf8')
  check('★ main.cjs 没被改（Phase 2 的装配不在那儿）', !/ext-bridge/.test(mainSrc))

  /* ── ⑤ 扩展侧规矩 ── */
  group('扩展桥 · 扩展侧权限与边界')

  const manifest = JSON.parse(readFileSync(join(ROOT, 'harbor-edge/extension/manifest.json'), 'utf8'))
  const perms = manifest.permissions ?? []
  check('★ 有 activeTab（点一下才授权，安装时不吓人）', perms.includes('activeTab'))
  check('★ 有 scripting（executeScript 必须声明它）', perms.includes('scripting'))
  check('★ 没有 host_permissions（本阶段绝不加 <all_urls>）', manifest.host_permissions === undefined)
  check('★ 没有 optional_host_permissions（同样本阶段不加）', manifest.optional_host_permissions === undefined)

  const sw = readFileSync(join(ROOT, 'harbor-edge/extension/service-worker.js'), 'utf8')
  check('★ 只查活动标签（active + currentWindow，不遍历后台页）', /active:\s*true,\s*currentWindow:\s*true/.test(sw))
  check('★ 读页面只由消息触发（没有任何定时器去读页面）', /msg\.type === 'read-page'/.test(sw))
  check('★ 内部页要拒（chrome:// edge:// about: …）', /BLOCKED_PROTOCOL/.test(sw) && /edge/.test(sw))
  check('★ 拒的话术是给用户看的人话', /该页面不支持读取/.test(sw))
  check('★ 正文有上限（不然会撑爆 1MB 的单条消息）', /MAX_TEXT/.test(sw))
  check('★ 扩展侧不做包装（包装是内核的职责，抄一份就会漂）', !/不是指令/.test(sw))

  /* ── ⑥ Phase 3a：通道层拆分 + 会话列表（只读）── */
  group('扩展桥 · Phase 3a（通道层 / 会话列表）')

  const nativeSrc = readFileSync(join(ROOT, 'harbor-edge/extension/lib/native.js'), 'utf8')
  /* ★ 断言只扫**代码**（去掉注释）：注释里提到 pendingRead（说明「从单槽升级」）是对的，
     代码里真用它才是问题 —— 与 154 里「不 require electron」那条同一个道理。 */
  const nativeCode = nativeSrc.replace(/\/\*[\s\S]*?\*\//g, '')
  check(
    '★ 通道层拆出来了，且是「按 id 匹配」的 Map（支持并发，不再是单槽）',
    /pending\.set\(/.test(nativeCode) && /pending\.has\(msg\.id\)/.test(nativeCode),
  )
  check(
    '★ 回帧只按 id 匹配（host 回的 type 是 xxx.result，按 type 会错位）',
    /pending\.has\(msg\.id\)/.test(nativeCode) && !/pendingRead/.test(nativeCode),
  )
  check('★ SW 用通道层发请求', /requestHost\(/.test(sw))
  check('★ SW 有 session-list 入口（Phase 3a 只读）', /'session-list'/.test(sw) && /getSessionList/.test(sw))
  check(
    '★ SW 是 ESM（manifest 必须声明 type=module，否则 import 直接失败）',
    manifest.background?.type === 'module',
    String(manifest.background?.type),
  )
  /*
   * 3a 时这里钉的是「SW 里没有任何发送入口」。3b 起**发送合法了** ——
   * 于是改成钉「发送有了，但**切会话仍然没有**」（那是 3c）。
   * ★ 别把这条再写成「SW 不该有 X」的笼统形态：3a 那次就是这么写的，
   *   到 3b 变成假红（红的是断言，不是产品）。
   */
  check('★ 3b：SW 有发送入口（chat-send）', /'chat-send'/.test(sw) && /sendChatMessage/.test(sw))
  check('★ 3c 未做：SW 里仍没有「切会话」入口', !/switch-session|select-session/.test(sw))
}
