/**
 * 自检 / native host 的**装配层**（Phase 1b）：路径 2 判据 + 安装脚本 + fuse 保命线
 *
 * 与 154 的分工：154 守**协议层**（帧编解码、handleMessage、白名单、stdout 纪律），
 * 本组守**装配层** —— 即「Edge 到底怎么把 host 拉起来、拉起后靠什么认身份、
 * 以及这条路依赖的那个 Electron 开关有没有被关掉」。
 *
 * 三块：
 *   ① **路径 2 的身份判据**：`.cmd` 包装器设 `ELECTRON_RUN_AS_NODE=1` 再调
 *      `Harbor.exe native-host.cjs`。这条路上的关键是**不能误伤正常启动** ——
 *      所以「开了 Node 模式但目标不是 main.cjs」必须判**否**。
 *      `--parent-window=` 那条兼容形态保留（留给将来 Edge 换拉起方式）。
 *   ② **安装脚本**：`.cmd` 必须**纯 ASCII**（cmd.exe 按 GBK 读，中文注释会变成
 *      乱码然后被当命令执行 —— 真踩过）；不许用 `chcp` 修（它会往 stdout 写字，
 *      而 stdout 就是协议通道）；注册表写 Edge 的根、两个视图都写；清单落 `data/`。
 *   ③ **★ fuse 保命线**：路径 2 依赖 `ELECTRON_RUN_AS_NODE`，而它受 Electron 的
 *      **runAsNode fuse** 控制。当前打包链从不翻 fuse（所以是启用的），但这条断言
 *      把「以后有人翻坏了」变成一次自检红。读字节而不是跑进程 —— 跑 electron.exe
 *      启动失败会弹原生对话框，装进 CI 就是会卡住的坑。
 */

import { existsSync, join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

export async function run() {
  const H = require(join(ROOT, 'electron/native-host.cjs'))

  /* ══════════════════════════════════════════════════════════════
     ★ Phase 1b：**路径 2** 的保命线（.cmd + ELECTRON_RUN_AS_NODE）
     ══════════════════════════════════════════════════════════════ */

  group('native host · 路径 2 身份判据（.cmd + ELECTRON_RUN_AS_NODE）')

  check('★ 常量就是 Electron 官方那个环境变量名', H.RUN_AS_NODE_ENV === 'ELECTRON_RUN_AS_NODE', String(H.RUN_AS_NODE_ENV))
  check(
    '★ Node 模式 + argv 指 main.cjs → 认（防「用 Node 模式跑 main.cjs」的误配）',
    H.isHostArgv(['Harbor.exe', 'electron/main.cjs'], { ELECTRON_RUN_AS_NODE: '1' }) === true,
  )
  check(
    '★ argv 指 main.cjs 但**没开** Node 模式 → 不认（正常启动不该被劫持）',
    H.isHostArgv(['Harbor.exe', 'electron/main.cjs'], {}) === false,
  )
  check('★ 开了 Node 模式但目标不是 main.cjs → 不认', H.isHostArgv(['Harbor.exe', '-e', 'x'], { ELECTRON_RUN_AS_NODE: '1' }) === false)
  check(
    '★ argv 显式指 native-host.cjs → 认（包装器的另一种写法）',
    H.isHostArgv(['Harbor.exe', 'E:\\a\\electron\\native-host.cjs'], {}) === true,
  )
  check(
    '★ **兼容形态保留**：--parent-window= 仍然认（留给将来 Edge 换拉起方式）',
    H.isHostArgv(['Harbor.exe', 'chrome-extension://x/', '--parent-window=0'], {}) === true,
  )
  check('★ 普通启动（只有 exe）→ 不认', H.isHostArgv(['Harbor.exe'], {}) === false)

  group('native host · 安装脚本（纯 ASCII / 三条规矩 / 路径自洽）')

  const EDGE_DIR = join(ROOT, 'harbor-edge')
  const SHELL_FILES = ['harbor-host.cmd', 'install-host.cmd', 'uninstall-host.cmd']

  /**
   * ★ 为什么专门测「纯 ASCII」：cmd.exe 按 **OEM 码页**（中文 Windows 是 GBK）
   *   读 `.cmd`，非 ASCII 的注释字节会变成乱码、**然后被当命令执行** ——
   *   Phase 1b 真踩过（`'──────' 不是内部或外部命令`）。
   *   放行 TAB / LF / CR / 可打印 ASCII；**CR 必须放行**：Windows 上 git checkout
   *   可能把行尾转成 CRLF，把 CR 判成危险会造成假红。
   */
  const asciiSafe = (text) =>
    [...text].every((ch) => {
      const c = ch.codePointAt(0)
      return c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)
    })

  /**
   * 只取 `.cmd` 里**会真正执行**的行（去掉 rem / :: 注释）——
   * 判据只看这些：注释里出现 `chcp` 或 `@echo off` 是在说明规矩，不是违规。
   */
  const activeLines = (text) =>
    text
      .split(/\r?\n/)
      .filter((line) => {
        const s = line.trim().toLowerCase()
        return s && !s.startsWith('rem') && !s.startsWith('::')
      })
      .join('\n')

  for (const f of SHELL_FILES) {
    const p = join(EDGE_DIR, f)
    check(`★ ${f} 存在`, existsSync(p), p)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    const bad = [...text].filter((ch) => {
      const c = ch.codePointAt(0)
      return !(c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126))
    })
    check(`★ ${f} 是纯 ASCII（中文注释会被 cmd 当命令执行）`, bad.length === 0, `非 ASCII 字符 ${bad.length} 个：${JSON.stringify(bad.slice(0, 5).join(''))}`)
  }

  const wrapPath = join(EDGE_DIR, 'harbor-host.cmd')
  const wrapSrc = existsSync(wrapPath) ? readFileSync(wrapPath, 'utf8') : ''
  const wrapActive = activeLines(wrapSrc)

  check('★ 包装器有 @echo off（否则命令回显污染帧）', /^\s*@echo off/im.test(wrapActive))
  check('★ 包装器**不执行** chcp（chcp 会往 stdout 写字 = 直接污染协议）', !/chcp/i.test(wrapActive), wrapActive.split('\n').filter((l) => /chcp/i.test(l)).join(' | '))
  check('★ 包装器不转发 %*（脚本故意不收参数）', !wrapActive.includes('%*'))
  check('★ 包装器设了 ELECTRON_RUN_AS_NODE=1', /set\s+ELECTRON_RUN_AS_NODE=1/i.test(wrapActive))
  check('★ 包装器用 %~dp0 相对定位（整个目录能搬走）', wrapActive.includes('%~dp0'))
  check('★ 包装器调的是 electron/native-host.cjs', wrapActive.includes('native-host.cjs'))
  check('★ 包装器调的是 Harbor.exe（自带 Electron，不依赖用户装 Node）', /Harbor\.exe/i.test(wrapActive))

  const installSrc = existsSync(join(EDGE_DIR, 'install-host.cmd')) ? readFileSync(join(EDGE_DIR, 'install-host.cmd'), 'utf8') : ''
  const uninstallSrc = existsSync(join(EDGE_DIR, 'uninstall-host.cmd')) ? readFileSync(join(EDGE_DIR, 'uninstall-host.cmd'), 'utf8') : ''
  /*
   * ⚠️ 大小写不敏感：cmd 里习惯写 `HKCU\SOFTWARE\...`（大写），而文档里常写 `Software`。
   *    注册表路径本身不区分大小写 —— 断言要是区分，就会因为一个字母的写法差异假红。
   */
  check('★ 安装脚本写的是 Edge 的注册表根（不是 Chrome 的）', /software\\microsoft\\edge\\nativemessaginghosts/i.test(installSrc))
  check('★ 安装脚本不写死扩展 ID（必须真加载读回来才能进 allowed_origins）', !/allowed_origins[^\n]*chrome-extension:\/\/[a-p]{32}/.test(installSrc))
  check('★ 安装脚本调 read-extid 拿真实 ID', installSrc.includes('read-extid.cjs'))
  check('★ 安装脚本写的是生产的注册表键 com.harbor.agent', installSrc.includes('com.harbor.agent'))
  check('★ 安装脚本两个视图都写（官方搜索顺序 64 / 32 都查）', /\/reg:64/.test(installSrc) && /\/reg:32/.test(installSrc))
  check('★ 卸载脚本两个视图都删（只删一个会留下孤儿键）', /\/reg:64/.test(uninstallSrc) && /\/reg:32/.test(uninstallSrc))
  check('★ 清单落 data/ 下（硬约束 #3：数据只落 data/）', installSrc.includes('data\\edge-host'))
  check('★ 安装脚本转义反斜杠（JSON 里路径要翻倍，cmd 用 %VAR:\\=\\\\%）', installSrc.includes(':\\=\\\\%'))

  group('native host · ★ fuse 保命线（runAsNode 必须启用）')

  /*
   * 为什么这条必须有：路径 2 依赖 `ELECTRON_RUN_AS_NODE`，而它受 Electron 的
   * **runAsNode fuse** 控制（官方文档：禁用后该环境变量被忽略）。当前打包链
   * （`scripts/build-portable.mjs` 是纯 `cpSync`）从不翻 fuse，所以是启用的 ——
   * 但「现在没翻」不等于「以后不会翻」。这条断言把「以后有人给构建链加了翻 fuse 的
   * 工具、顺手把 runAsNode 禁掉」变成一次**自检红**。
   *
   * ★ 为什么读字节、而不是跑进程验：跑进程需要启动 electron.exe，它一旦启动失败
   *   会弹一个**原生对话框要人点** —— 装进自检（CI 也跑）就是一个会卡住的坑。
   *   fuse wire 的格式是官方文档写死的：sentinel + version + length + wire，
   *   每个字节 '0'=disabled / '1'=enabled / 'r'=removed（第 0 位就是 runAsNode）。
   */
  const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'

  function readFuseWire(file) {
    const buf = readFileSync(file)
    const at = buf.indexOf(Buffer.from(FUSE_SENTINEL, 'ascii'))
    if (at === -1) return null
    const base = at + FUSE_SENTINEL.length
    const version = buf[base]
    const length = buf[base + 1]
    return { version, length, wire: buf.subarray(base + 2, base + 2 + length).toString('ascii') }
  }

  const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  let electronWire = null
  if (existsSync(electronExe)) {
    electronWire = readFuseWire(electronExe)
    check('★ 读到了 electron.exe 的 fuse wire（哨兵 + version + length + wire）', Boolean(electronWire), JSON.stringify(electronWire))
    if (electronWire) {
      check(
        '★★ runAsNode fuse 是 enabled（**路径 2 的命门**，被禁则 ELECTRON_RUN_AS_NODE 失效）',
        electronWire.wire[0] === '1',
        `wire="${electronWire.wire}"（第 0 位 = runAsNode，'1'=enabled）`,
      )
      check('★ fuse wire 长度与官方 schema 一致（9 个 fuse）', electronWire.length === 9 && electronWire.wire.length === 9, `length=${electronWire.length} wire=${electronWire.wire.length}`)
    }
  } else {
    check('（跳过）没装 electron，读不到 fuse wire', true, electronExe)
  }

  const packagedExe = join(ROOT, 'dist-portable', 'Harbor', 'Harbor.exe')
  if (existsSync(packagedExe)) {
    const packagedWire = readFuseWire(packagedExe)
    check(
      '★ 便携版 Harbor.exe 的 fuse 与 electron.exe 一致（打包链没把 fuse 翻坏）',
      Boolean(packagedWire) && Boolean(electronWire) && packagedWire.wire === electronWire.wire,
      packagedWire ? `打包="${packagedWire.wire}" electron="${electronWire?.wire ?? '?'}"` : '没读到便携版的 fuse wire',
    )
  }
}
