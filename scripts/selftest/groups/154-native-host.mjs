/**
 * 自检 / native host 帧协议 + 身份判据 + 模块白名单（Phase 1a）
 *
 * 本组守的是 Edge 扩展那条路的**协议层**，三块：
 *   ① **帧编解码**：4 字节小端长度 + UTF-8 JSON 体。stdin 会粘包也会半帧，
 *      所以解码必须是**增量**的 —— 这条最容易写成「一次一块」然后真机上偶发丢帧。
 *   ② **身份判据** `--parent-window=`：Phase 0 实测，宿主清单的 `path`
 *      **不能带参数**，所以只能靠 Edge 自己传的这个参数认身份。
 *      ⚠️ 空值（`--parent-window=`）**也要算** —— service worker 上下文里
 *      Edge 传的就是 `--parent-window=0`，官方也说过值不保证有内容。
 *   ③ **模块白名单**：只准碰「顶层不 require electron」的那 15 个。
 *      `handlers/browser.cjs` 那种顶层解构 electron 的模块在纯 Node 里
 *      「能加载但拿到 undefined」—— 用起来才炸（Phase 0 实测）。
 *
 * 另外钉两条**接线**：main.cjs 的分支必须在单实例锁**之前**；
 * 判据字面量只有一处真相源（别在 main.cjs 里再手写一遍 `--parent-window=`）。
 */

import { existsSync, join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

export async function run() {
  const H = require(join(ROOT, 'electron/native-host.cjs'))
  const src = readFileSync(join(ROOT, 'electron/native-host.cjs'), 'utf8')
  const mainSrc = readFileSync(join(ROOT, 'electron/main.cjs'), 'utf8')

  group('native host · 帧编解码（4 字节小端长度 + JSON）')

  const one = H.encodeFrame({ ping: 1 })
  check('★ 帧头是 4 字节小端长度', one.readUInt32LE(0) === one.length - 4, one.toString('hex'))
  check('★ 帧体是 UTF-8 JSON', one.subarray(4).toString('utf8') === '{"ping":1}')

  const empty = H.decodeFrames(Buffer.alloc(0))
  check('★ 空输入 → 0 条消息、0 错误（不抛）', empty.messages.length === 0 && empty.errors.length === 0)
  check('★ 空输入 → rest 是空 Buffer（攒着等下一块）', empty.rest.length === 0)

  const single = H.decodeFrames(one)
  check('★ 单帧 → 解出 1 条', single.messages.length === 1 && single.messages[0].ping === 1)

  const glued = H.decodeFrames(Buffer.concat([H.encodeFrame({ a: 1 }), H.encodeFrame({ b: 2 }), H.encodeFrame({ c: 3 })]))
  check('★ 粘包（3 帧一次给）→ 全部解出', glued.messages.length === 3, JSON.stringify(glued.messages))
  check('★ 粘包后 rest 为空（没漏字节）', glued.rest.length === 0)

  /* 半帧：这是真机上最容易偶发的一条 —— 必须留着、不能提前消费 */
  const half = H.decodeFrames(one.subarray(0, Math.floor(one.length / 2)))
  check('★ 半帧 → 一条都不解（等下一块）', half.messages.length === 0 && half.errors.length === 0)
  const joined = H.decodeFrames(Buffer.concat([half.rest, one.subarray(Math.floor(one.length / 2))]))
  check('★ 半帧补全 → 解出 1 条', joined.messages.length === 1 && joined.messages[0].ping === 1)

  /* 长度前缀只有 3 个字节 → 连长度都读不出，攒着 */
  check('★ 只有 3 字节（长度都没齐）→ 攒着', H.decodeFrames(Buffer.from([1, 2, 3])).rest.length === 3)

  const huge = Buffer.alloc(4)
  huge.writeUInt32LE(H.MAX_FRAME + 1, 0)
  const over = H.decodeFrames(huge)
  check('★ 超长帧 → fatal（协议已无法对齐，只能断）', over.fatal === true && over.errors.length === 1, over.errors.join('|'))
  check('★ 超长帧不再往后解（不会读越界）', over.messages.length === 0)

  const badHead = Buffer.alloc(4)
  badHead.writeUInt32LE(5, 0)
  const badOut = H.decodeFrames(Buffer.concat([badHead, Buffer.from('xxxxx')]))
  check('★ 畸形帧（帧体不是 JSON）→ 记错误但**不抛**', badOut.errors.length === 1 && badOut.messages.length === 0, badOut.errors.join('|'))

  group('native host · 身份判据 --parent-window=')

  check('★ 含 --parent-window=0 → 是 host 模式', H.isHostArgv(['Harbor.exe', 'chrome-extension://x/', '--parent-window=0']) === true)
  check('★ 空值 --parent-window= → **也算**（值不保证有内容）', H.isHostArgv(['Harbor.exe', '--parent-window=']) === true)
  check('★ 普通启动（只有 exe）→ 不是 host 模式', H.isHostArgv(['Harbor.exe']) === false)
  check('★ 自检 / 截图模式不会被误判成 host', H.isHostArgv(['exe', '--self-test']) === false && H.isHostArgv(['exe', '--screenshot']) === false)
  check('★ 参数在中间位置也认', H.isHostArgv(['exe', '--parent-window=99', '--other']) === true)
  check('★ 空 / 非数组 / 含非字符串 → 不抛且为 false', H.isHostArgv([]) === false && H.isHostArgv(null) === false && H.isHostArgv([1, 2]) === false)
  check('★ 判据字面量只有一处真相源（main.cjs 里不手写这个词）', !mainSrc.includes('--parent-window='), 'main.cjs 应当只调 isHostArgv')

  group('native host · handleMessage（Phase 1a 只有 ping/pong）')

  const pong = H.handleMessage({ ping: 1 })
  check('★ {"ping":1} → {"pong":1, echo:原消息}', pong.pong === 1 && pong.echo.ping === 1, JSON.stringify(pong))
  check('★ ping 值为别的也回（只认键在不在）', H.handleMessage({ ping: 'x' }).pong === 1)
  check('★ 不认识的消息 → 回 error（不抛、不静默丢）', typeof H.handleMessage({ nope: 1 }).error === 'string')
  check('★ null / 字符串 → 也回一条（不抛）', typeof H.handleMessage(null).error === 'string' && typeof H.handleMessage('x').error === 'string')

  group('native host · 模块白名单（哪些能加载、哪些不能）')

  /*
   * ⚠️ **不钉个数**（硬约束 #8：会涨的数字不写死）。Phase 2 加了两个模块
   * （ext-bridge / ext-forward），原来钉的「15 个」当场过期 ——
   * 而真正要守的不是个数，是下面那条「每一个都真的能在纯 Node 里 require」。
   */
  check('★ 白名单非空且至少覆盖 Phase 0 §4 验证过的那批', H.SAFE_MODULES.length >= 15, String(H.SAFE_MODULES.length))
  check('★ 白名单里没有 handlers/ 开头的（它们顶层解构 electron）', !H.SAFE_MODULES.some((m) => m.startsWith('handlers/')))
  check('★ 白名单里没有 native-host 自己（避免自引用）', !H.SAFE_MODULES.includes('native-host.cjs'))
  check('★ 每个模块路径都真实存在', H.SAFE_MODULES.every((m) => {
    try {
      readFileSync(join(ROOT, 'electron', m), 'utf8')
      return true
    } catch {
      return false
    }
  }))
  /* 真加载一遍：这才叫钉住。自检本身就跑在隔离数据目录里（paths.cjs 的 isSelftestRun） */
  const failed = []
  for (const m of H.SAFE_MODULES) {
    try {
      require(join(ROOT, 'electron', m))
    } catch (error) {
      failed.push(`${m}: ${error instanceof Error ? error.message : error}`)
    }
  }
  check('★ 白名单里每个模块在纯 Node 里**真的能 require**', failed.length === 0, failed.join(' | '))
  check('★ 不在白名单的反例：handlers/browser.cjs 顶层确实要 electron', /require\(['"]electron['"]\)/.test(readFileSync(join(ROOT, 'electron/handlers/browser.cjs'), 'utf8')))

  group('native host · 接线（真的被 main.cjs 用上了）')

  /*
   * ⚠️ 下面两条**不要**写成 `mainSrc.includes("require('./native-host.cjs')…")` ——
   * 那个字符串字面量会被「相对 require 路径都要存在」这条静态检查当成**真的 require**，
   * 于是拿本文件所在目录去解析，报「./native-host.cjs 不存在」（已踩，见 98-rollback-preview.mjs 的同一处注释）。
   * 所以这里只断言**片段**，不带 `require(` 前缀。
   */
  check('★ main.cjs 调了 isHostArgv', mainSrc.includes('isHostArgv()'))
  check('★ 调了 native-host 的 run', mainSrc.includes('native-host.cjs'))
  const hostAt = mainSrc.indexOf('isHostArgv()')
  const lockAt = mainSrc.indexOf('requestSingleInstanceLock')
  check('★ 分支在单实例锁**之前**（host 不抢锁）', hostAt > 0 && lockAt > 0 && hostAt < lockAt, `isHostArgv@${hostAt} lock@${lockAt}`)
  const createAt = mainSrc.indexOf('function createWindow')
  check('★ 分支在建窗口代码之前', hostAt > 0 && createAt > 0 && hostAt < createAt)
  /*
   * ⚠️ 这里断言的是「**不要**用顶层 return」。CJS 的顶层 return 在 Node 合法、
   *    `tsc` 不认（TS1108），所以阻断后续靠的是 run() **同步阻塞永不返回**。
   */
  check('★ 分支不含顶层 return（TS1108），靠 run() 同步阻塞阻断后续', /isHostArgv\(\)\)\s*require\(/.test(mainSrc) && !/isHostArgv\(\)\)\s*return/.test(mainSrc))

  group('native host · stdout 是协议通道（保命线）')

  check('★ run() 里把 console.log 改道到 stderr（否则日志会污染帧）', /console\.log = \(\.\.\.args\) => console\.error\(\.\.\.args\)/.test(src))
  /*
   * ★ 判据只扫**代码**（去掉块注释）：本模块的文件头白名单说明里就写着
   *   「顶层不 require electron」这件事，连字面量 `require('electron')` 都出现过
   *   （在解释 handlers/browser.cjs 为什么不行）。注释里提到它是对的，
   *   代码里真调用它才是问题 —— 所以先把块注释剥掉再测。
   */
  const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  check('★ 模块**代码**里不 require electron（纯 Node 能 require = 已证）', !/require\(['"]electron['"]\)/.test(codeOnly(src)), '（注释里提到不算 —— 只测代码）')
  check('★ 自己记状态走 stderr，不碰 stdout', src.includes('process.stderr.write') && !/process\.stdout\.write\([^)]*note/.test(src))
  /*
   * ★ 同步阻塞是**设计要求**，不是实现细节：
   *   顶层 `return` 会撞 tsc 的 TS1108（CJS 顶层 return 在 Node 合法、TS 不认），
   *   所以去 return 的唯一办法就是让 run() 永不返回。
   */
  check('★ run() 用同步 readSync(0)（不依赖事件流 → 天然不需要顶层 return）', src.includes('fs.readSync(0,'))
  check('★ 回帧用同步 writeSync(1)（stdout 是协议通道）', src.includes('fs.writeSync(1,'))
  check('★ run() 是「永不正常返回」的循环（for (;;)）', /for \(;;\) \{/.test(src))
  /*
   * ★ 这条是 Phase 1a 真机逮到的 bug：run() 收尾**必须 process.exit**。
   *   改成 `return` 的话，main.cjs 的 `if (isHostArgv()) run()` 后面那些
   *   建窗口 / 抢锁代码就会继续跑 —— 真机现象是「Edge 拉起的进程却开了窗口」。
   */
  check(
    '★ EOF / 读失败 / 协议失步都走 process.exit(0)，**不是 return**',
    /if \(got === 0\) process\.exit\(0\)/.test(src) && (src.match(/process\.exit\(0\)/g) ?? []).length >= 3,
    `process.exit(0) 出现 ${(src.match(/process\.exit\(0\)/g) ?? []).length} 次`,
  )

  /* ★ 端到端：起一个真子进程喂真帧 —— 这才叫「本地喂帧通过」 */
  const proc = require('node:child_process').spawn(process.execPath, [join(ROOT, 'electron/native-host.cjs')], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const outChunks = []
  const errChunks = []
  proc.stdout.on('data', (b) => outChunks.push(b))
  proc.stderr.on('data', (b) => errChunks.push(b))
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)))
  /* 三条一起喂（也顺带压一下粘包）+ 一条不认识的 */
  proc.stdin.write(Buffer.concat([H.encodeFrame({ ping: 1 }), H.encodeFrame({ ping: 'two' }), H.encodeFrame({ nope: 1 })]))
  await new Promise((r) => setTimeout(r, 700))
  proc.stdin.end()
  const code = await exited

  const raw = Buffer.concat(outChunks)
  const back = H.decodeFrames(raw)
  check('★ 子进程喂 3 帧 → 回 3 帧', back.messages.length === 3, `回了 ${back.messages.length} 帧`)
  check('★ 第一条就是 {"pong":1,echo:原消息}', back.messages[0]?.pong === 1 && back.messages[0]?.echo?.ping === 1, JSON.stringify(back.messages[0]))
  check('★ 不认识的消息回 error（不静默丢）', typeof back.messages[2]?.error === 'string')
  check('★ stdout 一个杂音字节都没有（纯协议帧）', back.rest.length === 0 && back.errors.length === 0, back.errors.join('|'))
  check('★ stdin 结束（浏览器关端口）→ 进程干净退出', code === 0, `退出码 ${code}`)
  check('★ 状态行走 stderr，不混进 stdout', Buffer.concat(errChunks).toString('utf8').includes('[native-host]'))

}
