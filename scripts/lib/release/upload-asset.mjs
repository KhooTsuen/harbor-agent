/**
 * 流式上传 Release 资产，带实时进度。
 *
 * 从 `github-release.mjs` 拆出来的（2026-11-03）—— 那边加完进度解析就到 322 行，
 * 破了硬约束 #2。拆的边界是**职责**不是行数：那个文件管「认仓库 / 拿凭据 / 发普通请求」，
 * 这里管「把一个 236MB 的文件流式发出去，并且让人看得见它在动」。
 * 顺手把它从 `lib/` 挪进 `lib/release/`：`lib/` 顶层留给通用工具，
 * 只管发布这一条链路的放子目录（顶层文件多了以后找东西全靠记）。
 *
 * ── 为什么不用 fetch ──
 * 原来用一次 `fetch` 发 236MB 的 body，两个后果：
 * ① `readFileSync` 把整个 zip 读进内存；② Node 的 fetch **没有上传进度事件**，
 * 于是 236MB / 26 分钟里脚本一个字都不输出 —— 被当成「卡死」掐掉过两次。
 * `curl --upload-file` 是流式读盘（内存几个 MB）。
 *
 * ── 进度为什么自己打（2026-11-03 再改）──
 * 旧写法只挂了个 30 秒心跳、写一句「还在传」—— 那不是进度，是安慰话；
 * 236MB 传 20 多分钟，30 秒才动一次照样像卡死。现在改成自己去解析 curl 的进度：
 * 把 stderr 接成管道，按固定节拍打一行「已传 X/Y MB（Z%），N 分 M 秒，K KB/s」。
 * 这样无论终端里跑、还是 `> log.txt` 里跑，看到的都是同一行有用的字。
 * ★ 关键坑：stderr 是管道（不是终端）时，curl 输出的是**旧式表格**、百分比**不带 % 号**。
 *   第一版按 `/(\d+)%/` 抠，自检时一个都抠不到 —— 具体格式见 progressOfCurlMeter。
 *
 * ── token 怎么给 ──
 * 走 `--config -` 从 stdin 喂 curl 配置：token 不进命令行（进程列表别的进程看得到），
 * 也不落盘 —— 和 `github-release.mjs` 文件头写的「token 只在内存里」是同一条规矩。
 *
 * ── 幂等 ──
 * 不加 `--retry-all-errors`：POST 上传失败后整体重试可能撞出重复资产。
 * `--retry` 只覆盖连上之前就失败的传输层错误（DNS / 连接被拒），那时还没发 body。
 * 真的传到一半断了，重跑脚本本身是安全的（调用方会先查同名资产是否已存在）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 系统自带的 curl.exe（Win10 1803 起内置）。没有就返回 null，让调用方回落。 */
export function resolveCurl() {
  const sys = process.env.SystemRoot || 'C:\\Windows'
  const exe = join(sys, 'System32', 'curl.exe')
  return existsSync(exe) ? exe : null
}

/**
 * 从 curl 的进度输出里抠出「已传百分比」和「当前速度」。
 *
 * ── 为什么不能找 `数字%`（2026-11-03 实测打脸）──
 * 第一版是按 `/(\d+)%/` 抠的，自检时**一个都抠不到**。把 curl 的 stderr
 * 原样打出来才看清：stderr 被接成管道（不是终端）时，curl 输出的是**旧式表格**，
 * 百分比只是行首那个**没有 % 号的**数字：
 *
 *     % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
 *     89 4096k    0     0   89 3648k      0   399k  0:00:10  0:00:09  0:00:01  400k
 *     100 4096k   0     0  100 4096k      0   405k  0:00:10  0:00:10 --:--:--  411k
 *
 * 所以按**列结构**认：一行 12 个字段、第 9 个是 `时:分:秒`，那就是数据行。
 * 首个字段＝百分比，末个字段＝当前速度（`476k` / `1.2M` 这种）。
 * 表头那两行带文字，按这个规则天然被排除。
 *
 * 速度为什么用 curl 给的这一列：自己拿 `已传/耗时` 算，百分比是阶梯状的，
 * 算出来会在几百 KB/s 之间来回跳（自检里 410→205→451→300 跳得很明显）；
 * curl 那一列是它自己平滑过的瞬时速度，看着才像话。
 *
 * @returns {{ percent: number, speed: number } | null} 不是数据行就返回 null
 */
export function progressOfCurlMeter(text) {
  let latest = null
  for (const frame of text.split(/[\r\n]+/)) {
    const tokens = frame.trim().split(/\s+/)
    if (tokens.length !== 12) continue
    if (!/^\d+:\d+:\d+$/.test(tokens[8])) continue
    if (!/^\d{1,3}$/.test(tokens[0])) continue
    const percent = Number(tokens[0])
    if (!(percent >= 0 && percent <= 100)) continue
    latest = { percent, speed: parseCurlSize(tokens[11]) }
  }
  return latest
}

/** curl 的尺寸写法（`476k` / `1.2M` / `4096`）→ 字节数；认不出就返回 0 */
export function parseCurlSize(token) {
  const m = /^(\d+(?:\.\d+)?)([kMG]?)$/.exec(String(token ?? '').trim())
  if (!m) return 0
  const scale = { '': 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2]]
  return Math.round(Number(m[1]) * scale)
}

/**
 * @param {object} options
 * @param {string} options.filePath 要传的文件
 * @param {number} [options.totalBytes] 文件大小（用于把百分比换算成 MB）
 * @param {boolean} [options.noProxy] 不让 curl 走 HTTP(S)_PROXY
 * @param {string} [options.endpoint] **只给自检用**：本地服务器地址，默认 GitHub 上传域
 * @param {number} [options.intervalMs] 进度节拍，默认 10 秒；自检传小值才看得到中间态
 * @param {string[]} [options.extraArgs] **只给自检用**：追加 curl 参数（如 --limit-rate）
 * @returns {Promise<null | { ok: boolean, status: number, json: any, text: string, elapsedSec: number }>}
 *          返回 null 表示这台机器没有 curl.exe
 */
export function uploadAssetWithCurl({
  token,
  owner,
  repo,
  releaseId,
  name,
  filePath,
  totalBytes = 0,
  noProxy = false,
  endpoint = 'https://uploads.github.com',
  intervalMs = 10_000,
  extraArgs = [],
}) {
  const curl = resolveCurl()
  if (!curl) return Promise.resolve(null)

  const url = `${endpoint}/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
  const config = [
    `url = "${url}"`,
    `header = "Authorization: Bearer ${token}"`,
    'header = "Accept: application/vnd.github+json"',
    'header = "X-GitHub-Api-Version: 2022-11-28"',
    'header = "User-Agent: harbor-release"',
    'header = "Content-Type: application/zip"',
    /* 让 curl 直接发 body：不去等 100-continue（GitHub 上那一步要白等一秒） */
    'header = "Expect:"',
    '',
  ].join('\n')

  const args = [
    '--config',
    '-',
    '--show-error',
    '--location',
    '--retry',
    '3',
    '--retry-delay',
    '5',
    '--retry-connrefused',
    '--connect-timeout',
    '30',
    /* 区分「慢」和「断了」：整体没有超时（慢网络也传得完），
       只有连续 5 分钟低于 1KB/s 才算真卡死。 */
    '--speed-limit',
    '1024',
    '--speed-time',
    '300',
    /* 进度自己解析（见文件头）。**不能加 `--silent`** —— 它会把进度表一起关掉，
       那样 stderr 里一个数据行都没有，只能干等（2026-11-03 第一次改就写错在这里）。 */
    ...(noProxy ? ['--noproxy', '*'] : []),
    '--upload-file',
    filePath,
    '--write-out',
    '\n__STATUS__%{http_code} %{time_total}',
    ...extraArgs,
  ]

  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(curl, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let errText = ''
    /* 进度只在**变大**时才更新 —— curl 偶尔会重画一帧旧的，
       百分比往回跳比不动更让人以为出了问题。 */
    let state = { percent: 0, speed: 0 }
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      errText += chunk.toString()
      /* 用累计文本、不用这一块 —— chunk 边界可能正好截断一行，
         单看这一块会漏掉那个数据行。meter 的输出总量很小（几十 KB），不必担心。 */
      const next = progressOfCurlMeter(errText)
      if (next && next.percent >= state.percent) state = next
    })
    child.stdin.on('error', () => {
      /* stdin 提前关掉不该把整个上传判死 */
    })
    child.stdin.end(config)

    /** 一行进度：已传 MB / 总 MB（1 位小数）+ 百分比 + 耗时 + 瞬时速度 */
    const say = (note) => {
      const secs = Math.max(1, Math.round((Date.now() - started) / 1000))
      /* 小文件取整会一直显示 0/8，所以留 1 位小数；
         大文件（236MB）那个小数位刚好给出「在动」的细粒度。 */
      const doneMb = totalBytes > 0 ? ((totalBytes * state.percent) / 100 / 1048576).toFixed(1) : '?'
      const allMb = totalBytes > 0 ? (totalBytes / 1048576).toFixed(1) : '?'
      const kbps = state.speed > 0 ? `，${Math.round(state.speed / 1024)} KB/s` : ''
      process.stderr.write(
        `\n  ${note}已传 ${doneMb}/${allMb}MB（${state.percent}%），${Math.floor(secs / 60)} 分 ${secs % 60} 秒${kbps}`,
      )
    }
    /* 10 秒一行（原来 30 秒）：236MB 传 20 多分钟，30 秒才动一次还是像卡住。
       百分比是 curl 实时给的，所以这行是**真进度**，不是"还在传"的安慰话。 */
    const beat = setInterval(() => say('…'), intervalMs)

    child.on('error', (error) => {
      clearInterval(beat)
      done({ ok: false, status: 0, json: null, text: `curl 起不来：${error.message}`, elapsedSec: 0 })
    })
    child.on('close', () => {
      clearInterval(beat)
      const tail = /__STATUS__(\d+)\s+([\d.]+)/.exec(out)
      const status = tail ? Number(tail[1]) : 0
      const body = out.replace(/\n__STATUS__[\s\S]*$/, '')
      let json = null
      try {
        json = body ? JSON.parse(body) : null
      } catch {
        /* 非 JSON 就只留文本 */
      }
      /* 失败时把 curl 的 stderr 尾巴带上 —— 否则只剩一个状态码，没法判断是网断了还是被拒。
         meter 行里全是 `\r` 和 `#`，压成一行只留最后一段。 */
      const tailErr = errText.replace(/[\r]/g, ' ').replace(/#+/g, ' ').replace(/\s+/g, ' ').trim().slice(-400)
      const failedText = status >= 200 && status < 300 ? body : `${body}\n${tailErr}`.trim()
      done({
        ok: status >= 200 && status < 300,
        status,
        json,
        text: failedText,
        elapsedSec: tail ? Number(tail[2]) : Math.round((Date.now() - started) / 1000),
      })
    })
  })
}
