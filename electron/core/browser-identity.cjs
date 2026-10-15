/**
 * 内置浏览器的「身份」：让 webview 发出的请求**看起来就是一台普通 Chrome**
 *
 * 只作用于 `persist:agent-browser` 这一个分区（网页标签），**绝不动主窗口**。
 *
 * ── 为什么需要它（2026-10-15 实测，不是猜的）────────────────────
 *
 * 本地探针（服务端读原始请求头）拿到的事实：
 *
 *   user-agent : …harbor-agent/1.30.0 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36
 *   sec-ch-ua  : 【完全没有】
 *
 * 同机同址用真 Chrome 访问，它发的是：
 *
 *   user-agent : …Chrome/156.0.0.0 Safari/537.36
 *   sec-ch-ua  : "Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"
 *
 * 差两处：**UA 里自报家门**（应用名 + Electron）、**Client Hints 三件套全缺**。
 * 这两条都是「不是真 Chrome」的显式标记，网站风控据此可以直接判定 ——
 * 而它们没有任何功能价值，纯属默认值。
 *
 * 指纹站 `bot.sannysoft.com` 的实测印证：整张表**只有 User Agent 一行异常**，
 * WebDriver / Chrome 对象 / plugins / WebGL 全部与真 Chrome 一致。
 * 所以这一批只补这一处，别的一概不动。
 *
 * ── 两条纪律 ────────────────────────────────────────────────
 *
 * ① **必须 UA 与 CH 一起补**。只改 UA 会留下「UA 说 Chrome、CH 说没有」的矛盾 ——
 *    那比完全不改**更**显眼（真 Chrome 不可能不发 CH）。所以两处一起。
 *
 * ② **不伪造需要 native 支撑的东西**。`window.chrome` 的 `csi` / `loadTimes`
 *    属于 Chromium 的 native binding，用 JS 假造出来的返回值比"空着"更容易被识破。
 *    本模块因此**只改网络层**，一行 JS 注入都不做（那件事另议，见设计文档）。
 *
 * ── 为什么版本号不写死 ────────────────────────────────────────
 *
 * 写死一个版本号，等 Electron 升级就成了新特征（UA 说 152、实际是 158）。
 * 所以一律从 `process.versions.chrome` 现取，只保留**主版本号**。
 *
 * ★ 主版本 + `.0.0.0` 不是偷懒，是**故意对齐 Chrome 自己的 UA reduction**：
 *   真 Chrome 的 UA 里写的就是 `Chrome/156.0.0.0`（次版本被抹掉）。
 *   Electron 默认那条是完整四段（`152.0.7977.78`），反而是个特征。
 *
 * ── 为什么不用 app.userAgentFallback ─────────────────────────
 *
 * 实测：给 `app.userAgentFallback` 赋值会让**进程直接崩掉**（静默退出，无报错）；
 * 命令行开关 `--user-agent=` 则完全无效。两条路都试过，都不能用。
 * 能用的是 `session.setUserAgent` + `onBeforeSendHeaders`，就是下面这套。
 *
 * ⚠️ 纯逻辑模块：**不 require electron**，所以内核自检能直接跑它。
 */

/** 从一个 UA 字符串里抠出 Chrome 主版本号；抠不到返回 0 */
function majorOf(ua) {
  const matched = /Chrome\/(\d+)\./.exec(String(ua ?? ''))
  return matched ? Number.parseInt(matched[1], 10) : 0
}

/** UA-CH 里的 GREASE 品牌（真 Chrome 156 实测就是这两个值，别改） */
const GREASE_BRAND = 'Not:A-Brand'
const GREASE_VERSION = '8'

/**
 * 本机 Chromium 的**主**版本号。取不到返回 0（调用方据此放弃改装，宁可不变也不要写个假的）
 */
function chromeMajor() {
  const raw = String(process.versions?.chrome ?? '')
  const major = Number.parseInt(raw.split('.')[0], 10)
  return Number.isFinite(major) && major > 0 ? major : 0
}

/** 操作系统在 UA 里的写法（跨平台如实反映，不写死 Windows） */
function uaPlatform(platform = process.platform) {
  if (platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7'
  if (platform === 'linux') return 'X11; Linux x86_64'
  return 'Windows NT 10.0; Win64; x64'
}

/** UA-CH 的 `sec-ch-ua-platform` 取值（带引号，按头里的格式） */
function chPlatform(platform = process.platform) {
  if (platform === 'darwin') return '"macOS"'
  if (platform === 'linux') return '"Linux"'
  return '"Windows"'
}

/**
 * 标准 Chrome 的 User-Agent。
 *
 * 形态：`Mozilla/5.0 (<平台>) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<主>.0.0.0 Safari/537.36`
 * —— 和真 Chrome 156 实测的字符串逐字同形，只是版本号跟着本机 Chromium 走。
 *
 * @param {number} [major] 主版本号；省略时取本机 Chromium
 * @returns {string} 取不到版本号时返回空串（调用方不装）
 */
function chromeUA(major = chromeMajor(), platform = process.platform) {
  if (!major) return ''
  return (
    `Mozilla/5.0 (${uaPlatform(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36`
  )
}

/**
 * UA-CH 三件套的值。
 *
 * ★ 品牌名在**请求头**里是 `Not:A-Brand`，在 JS 的 `navigator.userAgentData` 里是
 *   `Not?A_Brand` —— 这不是我写错，是 Chromium 自己的行为（`?`/`_` 会破坏头解析，
 *   所以两处故意不同）。这里只写头的那一份。
 *
 * 拿不到版本号时返回**空对象**（调用方一个头都不改，宁可不变也不写假的）。
 *
 * @param {number} [major] 主版本号
 * @returns {Record<string, string>} 键是头名、值是头内容
 */
function clientHints(major = chromeMajor(), platform = process.platform) {
  if (!major) return {}
  return {
    'sec-ch-ua': `"${GREASE_BRAND}";v="${GREASE_VERSION}", "Chromium";v="${major}", "Google Chrome";v="${major}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': chPlatform(platform),
  }
}

/**
 * `accept-language` 头的值。
 *
 * 为什么要自己拼、不用 `setUserAgent(ua, languages)` 的第二个参数：
 * 实测那条路会产生**畸形 q 值**（`zh-CN,zh;q=0.9;q=0.9,en;q=0.8;q=0.8`）——
 * 那是比不设更明显的特征。
 *
 * ★ 形态照真 Chrome 实测的那条抄：`zh-CN,zh;q=0.9`
 *   —— 第一项是**带地区的 locale**（与 `navigator.languages[0]` 对齐），
 *   第二项是它的基语言加 `q=0.9` 回退。
 *
 * ⚠️ 这里踩过一次（2026-10-15 真机走查逮到的）：早先用
 *   `app.getPreferredSystemLanguages()`（给的是 `zh-Hans-CN`）当第一项，
 *   结果头里报 `zh-Hans-CN`、而 JS 的 `navigator.languages[0]` 报 `zh-CN` ——
 *   **两者对不上本身就是个特征**（真 Chrome 这两处是同一份偏好派生的）。
 *   所以现在只收一个 locale，用它自己派生。
 *
 * @param {string | string[]} input 系统 locale（或它的数组，取第一项）
 * @returns {string} 形如 `zh-CN,zh;q=0.9`；非法 / 空 → 空串（调用方保持原样）
 */
function acceptLanguage(input) {
  const first = String((Array.isArray(input) ? input[0] : input) ?? '').trim()
  /* 只认语言标签的形状，挡掉脏值（系统 API 理论上不会给，但不赌） */
  if (!/^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/.test(first)) return ''
  const base = first.split('-')[0]
  /* 有地区就补一条基语言回退；纯语言（`en`）不用重复 */
  return base && base.toLowerCase() !== first.toLowerCase() ? `${first},${base};q=0.9` : first
}

/** 模块加载时就算好的 UA（正常环境里一定有值；取不到是空串） */
const CHROME_UA = chromeUA()

/**
 * 装到分区 session 上。
 *
 * 两件事一起做（只做一件会留下矛盾特征，见文件头纪律 ①）：
 *   ① `ses.setUserAgent(ua)` —— 网络层的 UA + `navigator.userAgent`
 *   ② `ses.webRequest.onBeforeSendHeaders` —— 把 CH 三件套补上
 *      （`setUserAgent` 不会连带改 CH，实测过）
 *
 * ★ CH 的主版本是**从最终 UA 里抠出来的**（`majorOf`），不是另算一次 ——
 *   同一次调用内同源，结构上不可能出现「UA 说 152、CH 说 158」那种矛盾。
 *
 * ⚠️ 一个 session 只允许**一个** `onBeforeSendHeaders` 监听器（后设的覆盖先设的）。
 *    本仓目前没有别处用它（已扫），所以这里独占是安全的；将来有人要加，
 *    得改成「一处注册、分发」而不是各装各的。
 *
 * @param {{ setUserAgent?: Function, webRequest?: object }} ses 分区 session
 * @param {{ log?: object, locale?: string, ua?: string }} [opts]
 *   `ua` 只为可测性留（纯 Node 下 `process.versions.chrome` 不存在，
 *   自检要能覆盖安装这条路）；正常调用**不要传**，走默认值。
 * @returns {boolean} 装上了没有；false = 不是 session / 拿不到版本号
 */
function install(ses, opts = {}) {
  const { log, locale } = opts
  if (!ses || typeof ses.setUserAgent !== 'function') return false

  const ua = opts.ua || CHROME_UA
  const major = majorOf(ua)
  if (!major) {
    log?.warn?.('内置浏览器：拿不到 Chromium 版本号，UA 保持原样（不猜一个假的）')
    return false
  }

  ses.setUserAgent(ua)

  const hints = clientHints(major)
  const lang = acceptLanguage(locale)

  if (ses.webRequest && typeof ses.webRequest.onBeforeSendHeaders === 'function') {
    ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      /*
       * ★ 这个回调**必须**被调用一次，否则那条请求会永远挂着。
       *   所以整体包在 try/catch 里，出错也要把原样的头交回去。
       */
      try {
        const headers = details?.requestHeaders ?? {}
        for (const [key, value] of Object.entries(hints)) {
          if (value) headers[key] = value
        }
        /* 语言：只在拿得到真实偏好时才写，否则保持 Electron 的默认值 */
        if (lang) headers['accept-language'] = lang
        callback({ requestHeaders: headers })
      } catch (error) {
        log?.warn?.(`内置浏览器：补请求头失败（按原样放行）：${error instanceof Error ? error.message : error}`)
        callback({})
      }
    })
  }

  log?.info?.(`内置浏览器身份已装上：${ua}`)
  return true
}

module.exports = {
  CHROME_UA,
  GREASE_BRAND,
  GREASE_VERSION,
  chromeMajor,
  chromeUA,
  majorOf,
  clientHints,
  acceptLanguage,
  install,
}
