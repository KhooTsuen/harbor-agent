/**
 * security:privacy 的凭证库专项（SEC-073 写入保护 / SEC-074 显式重置）
 *
 * 从 `privacy.mjs` 拆出来的（那边贴着 300 行红线）。放在 `suites/` 下但**不是套件**：
 * `run.mjs` 只会按 `cases.mjs` 的 SUITES 名单精确 `import('./suites/<名>.mjs')`，
 * 不会扫描目录，所以这个 helper 不会被当成套件跑。
 *
 * 隔离：`sandbox.mjs` 已 `paths.markPackaged(data/security-data)`，全程虚构凭证，
 * **不碰任何真实 API Key**。每个子场景都 `_resetCache()` + 删文件，从干净状态起。
 */

import { sec } from '../harness.mjs'
import { fs, path, require, ROOT, tmpDir } from '../sandbox.mjs'

const join = path.join

/** 与 ⑤ 用同一份 fixture：backend=safeStorage + 一段（本机解不开的）base64 密文 */
const SAFE_CIPHER_FIXTURE = JSON.stringify({
  version: 1,
  backend: 'safeStorage',
  entries: { 'provider:sec073f': { value: 'QkFTRTY0LUNJUEhFUlRFWFQ', updatedAt: 1 } },
}, null, 2)

/**
 * 「已 ready」这类生命周期由 `probes/cred-lifecycle.mjs` 在**独立子进程**里复刻。
 *
 * ★ 为什么不能在测试进程里伪造（2026-10-31 实测）：`npm run security` 跑在纯 Node 里，
 * `require('electron')` 返回 exe 路径字符串，`app.isReady()` 不存在 —— 所以需要伪造。
 * 但 `credentials.cjs` 的 `encryptionAvailable()` 会把 `true` **永久缓存**（设计如此：
 * 进程内 safeStorage 不会忽有忽无），`_resetCache()` 也不清它。同一进程里伪造过 `true`，
 * 之后所有用例都以为本机有加密能力、拿到的 `safeStorage` 却是 undefined，
 * 实测炸成 `Cannot read properties of undefined (reading 'encryptString')`。
 * 换进程 = 天然干净状态，且**不给产品代码加任何只读测试入口**（不动安全模型文件）。
 */
function runProbe(mode, order = 'set-first') {
  const { spawnSync } = require('node:child_process')
  const script = join(ROOT, 'scripts/security/probes/cred-lifecycle.mjs')
  const out = spawnSync(process.execPath, [script, mode, order], { encoding: 'utf8', timeout: 60000 })
  const line = String(out.stdout || '').trim().split('\n').filter(Boolean).pop() || ''
  try {
    return { ...JSON.parse(line), ok: true }
  } catch {
    return { ok: false, stderr: String(out.stderr || '').slice(-400), raw: line.slice(0, 200) }
  }
}

/** 隔离区里的凭证文件路径 + 一组「从干净状态开始」的助手 */
function ctx() {
  const credentials = require(join(ROOT, 'electron/core/credentials.cjs'))
  const paths = require(join(ROOT, 'electron/core/paths.cjs'))
  const credFile = join(paths.DIRS.data, 'credentials.json')
  return {
    credentials,
    credFile,
    fresh: () => {
      fs.rmSync(credFile, { force: true })
      credentials._resetCache()
    },
    writeRaw: (text) => {
      fs.mkdirSync(path.dirname(credFile), { recursive: true })
      fs.writeFileSync(credFile, text, 'utf8')
    },
  }
}

/** SEC-073：凭证库写入保护 —— 状态不明时拒绝写、先落盘后换内存 */
export function credentialWriteProtection() {
  const { credentials, credFile, fresh, writeRaw } = ctx()
  const realWrite = fs.writeFileSync
  const realRead = fs.readFileSync
  const read = () => realRead.call(fs, credFile, 'utf8')
  /** 把某个 fs 调用换成「只对目标文件生效」的一次性炸弹 */
  const bomb = (fn, real, match) => {
    fs[fn] = (p, ...rest) => {
      if (typeof p === 'string' && match(p)) {
        const e = new Error(`${fn} 被注入失败`)
        e.code = fn === 'readFileSync' ? 'EACCES' : 'ENOSPC'
        throw e
      }
      return real.call(fs, p, ...rest)
    }
  }

  try {
    /* ① 首次无文件：正常创建 + 读回（不是只读） */
    fresh()
    sec('SEC-073', credentials.set('provider:sec073a', 'sk-FAKE-073-a-0001').ok === true, '首次无文件也能正常保存')
    sec('SEC-073', credentials.get('provider:sec073a') === 'sk-FAKE-073-a-0001', '新建的凭证能读回')
    sec('SEC-073', credentials.status().health === 'ok', '健康态 ok')

    /* ② 非法 JSON：拒写、原文件字节不变 */
    fresh()
    writeRaw('{ 这不是合法 JSON')
    const before2 = read()
    let threw2 = false
    try { credentials.set('provider:sec073b', 'sk-FAKE-073-b') } catch { threw2 = true }
    sec('SEC-073', threw2, '损坏的凭证库拒绝写入（抛错，不静默覆盖）')
    sec('SEC-073', read() === before2, '拒写后原文件字节一字未变')
    sec('SEC-073', credentials.status().health === 'corrupt', '健康态如实报 corrupt')

    /* ③ 读取失败（EACCES）：拒写 */
    fresh()
    credentials.set('provider:sec073c', 'sk-FAKE-073-c')
    credentials._resetCache()
    bomb('readFileSync', realRead, (p) => p.endsWith('credentials.json'))
    let threw3 = false
    try { credentials.set('provider:sec073c2', 'sk-FAKE-073-c2') } catch { threw3 = true }
    fs.readFileSync = realRead
    sec('SEC-073', threw3, '读取失败（EACCES）时拒写')
    sec('SEC-073', credentials.status().health === 'unreadable', '健康态如实报 unreadable')

    /* ④ 写入失败（ENOSPC）：磁盘与内存都不提交 */
    fresh()
    credentials.set('provider:sec073d', 'sk-FAKE-073-d')
    credentials._resetCache()
    bomb('writeFileSync', realWrite, (p) => p.includes('credentials.json'))
    let threw4 = false
    try { credentials.set('provider:sec073e', 'sk-FAKE-073-e') } catch { threw4 = true }
    fs.writeFileSync = realWrite
    sec('SEC-073', threw4, '写入失败（ENOSPC）会抛出（不假报成功）')
    sec('SEC-073', credentials.has('provider:sec073e') === false, '写入失败后内存没有被错误提交')
    sec('SEC-073', credentials.has('provider:sec073d') === true, '写入失败后原有凭证仍在内存里')

    /* ⑤a 后端是 safeStorage、本机解不开，但**还没 ready**（= `npm run security` 的真实环境）：
       不写、不改 backend、不把密文当明文；并且**不许据此判死**。
       最后这条是 2026-10-27 真机修复的核心：ready 之前 safeStorage 恒返回 false，
       误判会让应用启动首行就报「有凭证解不开，已停止写入」，可 ready 之后一切正常。 */
    fresh()
    writeRaw(SAFE_CIPHER_FIXTURE)
    const before5 = read()
    let threw5 = false
    try { credentials.set('provider:sec073g', 'sk-FAKE-073-g') } catch { threw5 = true }
    sec('SEC-073', threw5, 'safeStorage 密文 + 本机无解密能力 → 拒绝写入')
    sec('SEC-073', credentials.status().health !== 'undecryptable',
      '未 ready 时不把库判死（不重演 2026-10-27 启动首行误报）')
    sec('SEC-073', read() === before5, '拒写后密文与 backend 一字未改')
    sec('SEC-073', JSON.parse(read()).backend === 'safeStorage', 'backend 没被重贴成 plain')
    let getThrew = false
    try { credentials.get('provider:sec073f') } catch { getThrew = true }
    sec('SEC-073', getThrew, '解不开的凭证取不出来（抛错，不把密文当明文返回）')

    /* ⑤b 「该报 undecryptable」的前置条件是**已 ready** —— 由子进程探针自己搭好 */
    const noEnc = runProbe('ready-noenc', 'get-first')
    sec('SEC-073', noEnc.ok && noEnc.healthFinal === 'undecryptable',
      `已 ready + 无加密能力 → 健康态报 undecryptable（实测 ${noEnc.healthFinal ?? noEnc.stderr}）`)
    sec('SEC-073', noEnc.ok && noEnc.setThrew && noEnc.bytesUnchanged && noEnc.fileBackend === 'safeStorage',
      '已 ready 判死后：拒写、字节不变、backend 仍是 safeStorage')

    /* ⑤b-负向：同一份 fixture、只把 ready 翻成 false → 结论必须翻转。
       没有这一条，上面的断言可能是空转（探针永远报 undecryptable 也能「通过」）。 */
    const notReady = runProbe('notready', 'get-first')
    sec('SEC-073', notReady.ok && notReady.healthFinal === 'ok',
      `（负向）同一 fixture 只把 ready 换 false → 不报 undecryptable（实测 ${notReady.healthFinal ?? notReady.stderr}）`)

    /* ⑤c 已 ready、声称能加密但解不开（换过 Windows 账户的真实形状）→ 读到即判死、随后拒写 */
    const brokeGetFirst = runProbe('ready-broken', 'get-first')
    sec('SEC-073',
      brokeGetFirst.ok && brokeGetFirst.getThrew && brokeGetFirst.setThrew
        && brokeGetFirst.healthFinal === 'undecryptable',
      `已 ready + 解不开（先读）→ 读抛错、写拒写、健康态 undecryptable（实测 ${brokeGetFirst.healthFinal ?? brokeGetFirst.stderr}）`)

    /* ⑤d 同一场景但**先写后读**：必须在**碰磁盘之前**就拒写。2026-10-31 之前这里是缺口：
       `load()` 只问 encryptionAvailable()（能加密 ≠ 能解旧密文），健康态还是 ok，于是这次
       set() 真把新条目写进去了（改前实测 setThrew=false / savedCount=2 / bytesUnchanged=false）。
       现在已 ready 就逐条真解，断言因此收紧到「拒写 + 新条目没落盘 + 字节不变」。 */
    const brokeSetFirst = runProbe('ready-broken', 'set-first')
    sec('SEC-073',
      brokeSetFirst.ok && brokeSetFirst.setThrew && brokeSetFirst.bytesUnchanged
        && brokeSetFirst.hasNew === false && brokeSetFirst.hasOriginal
        && brokeSetFirst.fileBackend === 'safeStorage'
        && brokeSetFirst.healthAfterFirstTouch === 'undecryptable',
      `已 ready + 解不开（先写）→ 第一次 set() 即拒写、新条目未落盘、旧密文与 backend 未变（实测 setThrew=${brokeSetFirst.setThrew}/hasNew=${brokeSetFirst.hasNew}/health=${brokeSetFirst.healthAfterFirstTouch ?? brokeSetFirst.stderr}）`)

    /* ⑤e **正对照**：同一份 fixture、同样已 ready，只是这台机器真能解 → 写入必须照常成功。
       没有这一条，把 load() 改成「safeStorage 一律判死」也能让 ⑤b–⑤d 全绿（空转）。 */
    const readyOk = runProbe('ready-ok', 'set-first')
    sec('SEC-073',
      readyOk.ok && readyOk.setThrew === false && readyOk.hasNew === true
        && readyOk.healthFinal === 'ok',
      `（正对照）已 ready 且真能解 → 照常写入（实测 setThrew=${readyOk.setThrew}/hasNew=${readyOk.hasNew}/health=${readyOk.healthFinal ?? readyOk.stderr}）`)

    /* ⑥ 运行期文件消失：拒写、不静默重建 */
    fresh()
    credentials.set('provider:sec073h', 'sk-FAKE-073-h')
    fs.rmSync(credFile, { force: true })
    let threw6 = false
    try { credentials.set('provider:sec073i', 'sk-FAKE-073-i') } catch { threw6 = true }
    sec('SEC-073', threw6, '运行期文件消失后拒绝写入（不静默重建）')
    sec('SEC-073', !fs.existsSync(credFile), '被删的文件没有被静默重建')

    /* ⑦ 负向：同样的注入打在「裸写」上 → 旧文件确实被截断（证明上面断言能失败） */
    const bare = join(tmpDir('cred-bare'), 'credentials.json')
    realWrite.call(fs, bare, 'ORIGINAL-CREDENTIALS-BYTES-0123456789', 'utf8')
    fs.writeFileSync = (p, data, ...rest) => {
      if (p === bare) {
        realWrite.call(fs, p, String(data).slice(0, 8), 'utf8')
        const e = new Error('ENOSPC')
        e.code = 'ENOSPC'
        throw e
      }
      return realWrite.call(fs, p, data, ...rest)
    }
    try { fs.writeFileSync(bare, 'REPLACEMENT-CRED-BYTES', 'utf8') } catch { /* 裸写抛了就对了 */ }
    fs.writeFileSync = realWrite
    sec('SEC-073', realRead.call(fs, bare, 'utf8') !== 'ORIGINAL-CREDENTIALS-BYTES-0123456789',
      '（负向）退回裸写时同样的注入会截断原文件 —— 证明「拒写 / 不改字节」断言能失败')
  } finally {
    fs.writeFileSync = realWrite
    fs.readFileSync = realRead
    fresh()
  }
}

/** SEC-074：凭证库显式重置（confirm 门槛 / 留档 / 不留半重置） */
export function credentialReset() {
  const { credentials, credFile, fresh, writeRaw } = ctx()
  const realRead = fs.readFileSync
  const realCopy = fs.copyFileSync
  const read = () => realRead.call(fs, credFile, 'utf8')

  try {
    /* ⑧ 缺 confirm：抛错、文件不动 */
    fresh()
    credentials.set('provider:sec074a', 'sk-FAKE-074-a')
    const before8 = read()
    let threw8 = false
    try { credentials.reset() } catch { threw8 = true }
    sec('SEC-074', threw8, 'reset() 缺 confirm 时抛错（没有未经确认的破坏性路径）')
    sec('SEC-074', read() === before8, '未确认的 reset 不动原文件')

    /* ⑨ 损坏库 reset：留档 + 回到可写 */
    fresh()
    writeRaw('{ 坏掉的 JSON')
    const r9 = credentials.reset({ confirm: true })
    sec('SEC-074', r9.ok === true && /\.corrupt-/.test(String(r9.archived)), `reset 留档损坏文件（${r9.archived}）`)
    sec('SEC-074', credentials.status().health === 'ok', 'reset 后健康态回到 ok')
    credentials.set('provider:sec074b', 'sk-FAKE-074-b')
    sec('SEC-074', credentials.get('provider:sec074b') === 'sk-FAKE-074-b', 'reset 后能正常写入')

    /* ⑩ 留档失败：中止，原文件与健康态都不动 */
    fresh()
    writeRaw('{ 又坏掉的 JSON')
    credentials.status() /* 触发一次 load → health=corrupt */
    const before10 = read()
    fs.copyFileSync = () => { throw new Error('EACCES: copy denied') }
    let threw10 = false
    try { credentials.reset({ confirm: true }) } catch { threw10 = true }
    fs.copyFileSync = realCopy
    sec('SEC-074', threw10, '留档失败时中止 reset（证据优先）')
    sec('SEC-074', read() === before10, '中止后原文件一字未改')
    sec('SEC-074', credentials.status().health === 'corrupt', '中止后健康态不变（仍拒写）')
  } finally {
    fs.readFileSync = realRead
    fs.copyFileSync = realCopy
    fresh()
  }
}
