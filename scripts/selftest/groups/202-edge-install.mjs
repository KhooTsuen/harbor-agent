/**
 * 自检 / 「在设置里一键装浏览器插件」（2026-11-04）
 *
 * ── 这一组钉什么 ───────────────────────────────────────────────
 *
 * 用户问的是「能不能在 Harbor 的扩展设置里点一下就装好」。结论是**装不全自动**：
 * Edge 不给扩展「自动加载本地目录」的接口，静默安装又只允许加载项商店里的扩展
 * （官方策略文档原话，见 core/edge-install.cjs 文件头）。所以做的是引导 ——
 * 而引导最容易出的错**全是静默的**：
 *
 *   ① **扩展 ID 算错**：ID 由 manifest 的 `key` 经 SHA-256 推导。算错了不会报错，
 *      只会「侧边栏连不上」，而人会以为是 host 装坏了。这里拿**真的 key** 算一遍，
 *      并且钉住「换目录 ID 不变」—— 那正是加 key 的全部目的。
 *   ② **包装器不是纯 ASCII / 带了 chcp**：cmd.exe 按 GBK 读 .cmd，中文注释会变成
 *      乱码然后被当命令执行（真踩过）。这是字节级判据，扫一遍就够。
 *   ③ **渲染层能传路径**：一旦 preload 或 handler 接受路径参数，界面就成了
 *      「往任意位置写注册表 + 任意路径当可执行文件」的入口。这里钉死「不收参数」。
 *   ④ **打包漏了扩展产物**：新用户点「安装」只会得到一句「没带产物」，而
 *      `build-portable.mjs` 少一步是没人会发现的（主程序照常能用）。
 *   ⑤ **界面把「写好配置」说成「装好了」**：唯一能说装好的判据是桥上有活连接。
 *
 * 全部**真跑**：算 ID、生成包装器、在临时目录里真装一遍（含真写注册表再恢复），
 * 不只看源码字面 —— 源码扫只用于「五处接线齐全」这类结构判据。
 */

import { existsSync, join, mkdirSync, readFileSync, rmSync, require, ROOT, writeFileSync } from '../env.mjs'
import { check, group, warn } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')

/** 自检期间被我们改过、最后要塞回去的注册表值（恢复用） */
const REG_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\com.harbor.agent'

export async function run() {
  const E = require(join(ROOT, 'electron/core/edge-install.cjs'))
  const manifest = JSON.parse(R('harbor-edge/extension/manifest.json'))

  /* ══════════════════════════════════════════════════════════════
     ① 扩展 ID 由 key 固定（这是「不用再抄 ID」的全部依据）
     ══════════════════════════════════════════════════════════════ */
  group('浏览器插件 · 扩展 ID 由 key 固定')

  check('★ manifest 里真的有 key（没有它 ID 就跟着目录走）', typeof manifest.key === 'string' && manifest.key.length > 100)

  const id = E.idFromKey(manifest.key)
  check('★★ 算出来的 ID 是 32 位小写字母', /^[a-p]{32}$/.test(id), id)
  /* 同一个 key 算两次必须一样 —— 纯函数，但这条钉的是「别哪天引入随机」 */
  check('★★ 同一个 key 永远算出同一个 ID', E.idFromKey(manifest.key) === id)
  check('★ 空 key / 坏 key 返回空串（不瞎算一个出来）', E.idFromKey('') === '' && E.idFromKey('not-base64!!') === '')

  /* 真值钉死：改了 key 就等于换了扩展 ID，Edge 里已装的扩展会失配 —— 必须是有意的 */
  check('★★★ 当前 key 算出的 ID 与 Edge 里要加载的那个一致', id === 'kmennhjfojbmadlmfndlljlgpljbdabm', id)

  /* ② 换目录 ⇒ ID 不变（key 的全部意义）：sourceDir 只影响读哪份 manifest，不影响 ID
     ★ 这条**要有产物**才算得出来：sourceDir 指的那份 manifest 不存在时，readManifest 返回
       null → 算出的 ID 是空串，判据必然假红（2026-11-04 CI 就是败在这一条上，
       同一类问题只修了一半）。所以先读一次，读不到就 warn，别拿假红盖住真红。 */
  const shipped = E.readManifest(E.sourceDir(ROOT))
  if (shipped) {
    check('★★ sourceDir 只决定读哪份产物，与 ID 无关', E.idFromKey(shipped.key) === id)
  } else {
    warn('sourceDir 与 ID 无关 —— 没验（缺扩展产物 harbor-edge/dist/sidepanel）')
  }

  /* ══════════════════════════════════════════════════════════════
     ③ 包装器字节纪律（cmd.exe 按 OEM 代码页读 .cmd）
     ══════════════════════════════════════════════════════════════ */
  group('浏览器插件 · 生成的包装器必须纯 ASCII')

  const wrapper = E.wrapperText({ dataDir: 'E:\\data\\root', exe: 'E:\\h\\Harbor.exe', script: 'E:\\h\\n.cjs' })
  check('★★★ 一个非 ASCII 字节都没有（真踩过：中文注释被当命令执行）', /^[\x00-\x7F]*$/.test(wrapper))
  check('★★ 没有 chcp（它往 stdout 写字，而 stdout 就是协议通道）', !/chcp/i.test(wrapper))
  check('★★ 有 @echo off（命令回显同样进 stdout）', wrapper.startsWith('@echo off'))
  check('★★ 设了 ELECTRON_RUN_AS_NODE=1（否则 Chromium 启动会污染帧头）', /set ELECTRON_RUN_AS_NODE=1/.test(wrapper))
  check('★★ 数据根以反斜杠结尾（paths.cjs 的 realDataDir 靠它拼）', /set HARBOR_DATA_ROOT=E:\\data\\root\\/.test(wrapper))
  check('★ 行尾是 CRLF（cmd 对裸 LF 不稳）', wrapper.includes('\r\n') && !/[^\r]\n/.test(wrapper))

  /* ══════════════════════════════════════════════════════════════
     ④ 在临时目录里真装一遍（含真写注册表 → 恢复）
     ══════════════════════════════════════════════════════════════ */
  group('浏览器插件 · 真装一遍（临时目录）')

  const tmp = join(ROOT, 'data', 'harbor-test', 'edge-install-selftest')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  /*
   * 用**真 root**（有 node_modules/electron/dist/electron.exe 和真产物），只把 data
   * 指到临时目录。造一个假 root 反而验不到真链路：native host 的可执行文件不在那儿。
   */
  const dataDir = join(tmp, 'data')
  const runtime = E.hostRuntime(ROOT)

  /*
   * ── 这一段只能在 Windows + 装齐前置的机器上真跑 ──────────────────
   * 三样前置缺一样就整组降级成 warn（不算过也不算不过），并把缺的东西点名打出来：
   *   ① `harbor-edge/dist/sidepanel/manifest.json` —— 扩展产物，要先构建 harbor-edge
   *   ② Electron 二进制 —— CI 刻意不下载（ELECTRON_SKIP_BINARY_DOWNLOAD=1）
   *   ③ Windows 注册表 —— Linux runner 上没有 HKCU，写不了 native host 清单
   * 以前这里是无条件 check，于是 2026-11-04 的 CI 上 10 条断言一起红，而**产品其实是好的**
   * —— 判据写成了「只有我这台机器才成立的形状」。缺前置时改用 warn：让「这里没验过」
   * 在输出里看得见，而不是拿一个假红把真红埋掉（同 19-abort / 118 那两处的口径）。
   */
  const missing = []
  if (!existsSync(join(E.sourceDir(ROOT), 'manifest.json'))) missing.push('扩展产物 harbor-edge/dist/sidepanel')
  if (!existsSync(runtime.exe) || !existsSync(runtime.script)) missing.push('Electron 二进制（node_modules/electron/dist）')
  if (process.platform !== 'win32') missing.push('Windows 注册表（HKCU）')

  if (missing.length > 0) {
    warn('本组跳过：这台机器缺前置条件', missing.join(' / '))
    warn('装一遍 / 幂等 / 拒绝空产物 / 注册表还原**都没有在本机真跑**（别把这里当成已验）')
  } else {
    check('★ 源码树里认得出跑 native host 的可执行文件', existsSync(runtime.exe) && existsSync(runtime.script), `${runtime.kind}`)

    const before = E.readRegistryPath()
    try {
      const applied = E.apply({ dataDir, root: ROOT })

      check('★★ 装成功（没报错）', applied.ok === true, applied.error ?? '')
      check('★★ 产物被拷到 data 下（Edge 要加载的就是它）', applied.staged === true, applied.targetDir)
      check('★★ 拷过去的 manifest 带同一个 ID', E.idFromKey(E.readManifest(applied.targetDir)?.key ?? '') === id)
      check('★★ 宿主清单写好了', existsSync(applied.hostManifest))
      check('★★ 清单的 allowed_origins 就是算出来的 ID', applied.hostOk === true)
      check('★★ 包装器是纯 ASCII', /^[\x00-\x7F]*$/.test(readFileSync(applied.wrapper, 'ascii')))
      check('★★ 包装器里指向的是**真**可执行文件', readFileSync(applied.wrapper, 'ascii').includes(runtime.exe))
      check('★★ 注册表指到了这份清单', applied.registered === true, E.readRegistryPath())

      /* 幂等：再装一遍不该造第二份，也不该报错 */
      const again = E.apply({ dataDir, root: ROOT })
      check('★★★ 重复安装是幂等的（不报错、结果一样）', again.ok === true && again.targetDir === applied.targetDir)
      check('★★ 状态里 connected 默认是 false（还没连上就不能说装好了）', applied.connected === false)

      /* 产物不存在时必须拒绝，而不是算一个空 ID 写进注册表 */
      const emptyRoot = join(tmp, 'empty-root')
      mkdirSync(emptyRoot, { recursive: true })
      const noSrc = E.apply({ dataDir, root: emptyRoot })
      check('★★★ 找不到产物时明确拒绝（不写空 ID 进注册表）', noSrc.ok === false && /manifest/.test(noSrc.error ?? ''), noSrc.error ?? '')
    } finally {
      /* 恢复注册表：装之前有值就写回它，没有就删掉这个键 */
      if (before) {
        require('node:child_process').spawnSync('reg', ['ADD', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', before, '/f'], {
          windowsHide: true,
        })
      } else {
        require('node:child_process').spawnSync('reg', ['DELETE', REG_KEY, '/f'], { windowsHide: true })
      }
    }

    check('★★ 自检跑完注册表被还原（不把测试的清单留在用户机器上）', E.readRegistryPath() === before, E.readRegistryPath())
  }

  rmSync(tmp, { recursive: true, force: true })

  /* ══════════════════════════════════════════════════════════════
     ⑤ 接线：五处齐全 + 渲染层不许传路径
     ══════════════════════════════════════════════════════════════ */
  group('浏览器插件 · 接线齐全且不收路径')

  const preloadSrc = R('electron/preload.cjs')
  const handlerSrc = R('electron/handlers/ext.cjs')
  const channelsSrc = R('electron/ipc-channels.cjs')

  check('★★ 通道登记在 EXPECTED_CHANNELS（漏了自检会点名）', /'ext:install'/.test(channelsSrc) && /'ext:status'/.test(channelsSrc))
  check('★★ preload 有两条白名单入口', /extStatus: \(\) => call\('ext:status'\)/.test(preloadSrc) && /extInstall: \(\) => call\('ext:install'\)/.test(preloadSrc))
  check('★★★ preload 这两条**不收任何参数**（收了就等于给界面开任意路径）', /extInstall: \(\) =>/.test(preloadSrc) && !/extInstall: \(\w/.test(preloadSrc))
  check('★★★ handler 也不收参数（路径全在 edge-install 里按数据根算）', /ipcMain\.handle\('ext:install', \(\) =>/.test(handlerSrc))
  check('★★ handler 用的是 paths.DIRS.data / root（不自己拼路径）', /paths\.DIRS\.data/.test(handlerSrc) && /paths\.DIRS\.root/.test(handlerSrc))
  check('★ 装完会顺手打开 edge://extensions（下一步就在那儿点）', /openExtensionsPage\(\)/.test(handlerSrc))

  /* ══════════════════════════════════════════════════════════════
     ⑥ 界面：判据是 connected，不能把「写好配置」说成装好了
     ══════════════════════════════════════════════════════════════ */
  group('浏览器插件 · 界面不谎报已安装')

  const cardSrc = R('src/components/settings/tabs/BrowserExtCard.tsx')
  const panelSrc = R('src/components/settings/panels/ExtensionPanel.tsx')
  check('★★ 挂在「扩展」设置页里', /<BrowserExtCard \/>/.test(panelSrc))
  check('★★★ 「已连接」只在 connected 为真时说', /if \(s\.connected\) return \{ text: '已连接/.test(cardSrc))
  check('★★ 没连上时说的是「等你在 Edge 里加载扩展」，不是「已安装」', /等你在 Edge 里加载扩展/.test(cardSrc))
  check('★★ 把要选的目录显示出来（否则用户不知道选哪儿）', /status\.targetDir/.test(cardSrc))
  check('★ 写了「为什么不能全自动」（免得用户以为没装好）', /静默安装只允许加载项商店/.test(cardSrc))

  /* ══════════════════════════════════════════════════════════════
     ⑦ 打包链必须带上扩展产物
     ══════════════════════════════════════════════════════════════ */
  group('浏览器插件 · 发布包里带得上产物')

  const buildSrc = R('scripts/build-portable.mjs')
  check('★★ build-portable 会拷 harbor-edge/dist/sidepanel', /harbor-edge',\s*'dist',\s*'sidepanel'/.test(buildSrc))
  check('★★ 主流程里真的调了它（定义了不调等于没做）', /copyEdgeExt\(\)/.test(buildSrc))
  check('★ 拷到 resources/app 下（与 edge-install 的 SOURCE_PACKAGED 同一处）', /'harbor-edge',\s*'dist',\s*'sidepanel'/.test(R('electron/core/edge-install.cjs')))
}
