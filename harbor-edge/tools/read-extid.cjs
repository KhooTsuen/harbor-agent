/**
 * 读「加载 harbor-edge/ext 时 Edge 实际给出的扩展 ID」。
 *
 * 为什么必须真加载一次：宿主清单的 `allowed_origins` 要写**真实 ID**，
 * 而 unpacked 扩展的 ID 由**加载路径**决定 —— 算不出来。Phase 0 实测：
 * 按 Chromium 算法手算得到 doacoiidbmccehjb，实际是 fgiopdanmkafnmpcjiiofkbbgikmdljn。
 * 换一次目录 ID 就会变（Phase 1a 换到 exp/ext 后又变成另一个）。
 *
 * ★ 为什么要重试：installer 的同一段代码第一次跑**失败过一次**（profile 是新建的，
 *   Edge 首次装扩展落盘慢）。首次失败、紧接着手动跑就成功 —— 这种「有时行有时不行」
 *   不该留在安装脚本里。所以每轮换一个**独立 profile 名**重试，读不到就再来一轮。
 *
 * 用法（install-host.cmd 内部调它，也可手动跑）：
 *   set ELECTRON_RUN_AS_NODE=1
 *   "<Harbor.exe>" "<本文件>"
 *
 * ★ stdout 只输出**一行 ID**（调用方用 for /f 捕获），其余信息一律走 stderr。
 */

const D = require('../lib/driver.cjs')

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const note = (t) => process.stderr.write(`[read-extid] ${t}\n`)

/** 起一次隔离 Edge、关掉、把扩展 ID 读回来，然后**把 profile 删掉** */
async function attempt({ profileName, port, extDir }) {
  const edge = await D.launchEdge(extDir ? { profileName, port, extDir } : { profileName, port })
  const profile = edge.profile
  note(`Edge 已起（CDP ready=${edge.ready}）profile=${profile} ext=${extDir || '(默认探针)'}`)
  try {
    /* 设置是在退出路径上落盘的，所以先关再读 */
    D.killEdge(edge.child.pid)
    await D.sleep(2000)
    /* ★ 读 ID 也必须用**同一个**扩展目录 —— 不然按路径比对必然找不到 */
    return extDir ? D.readExtIdFromProfile(profile, extDir) : D.readExtIdFromProfile(profile)
  } finally {
    /* ★ 无论读到没读到都要删：一个 profile 实测 15 MB，装一次留一个就是垃圾 */
    if (D.removeProfile(profile)) note('临时 profile 已清理')
  }
}

async function main() {
  const attempts = Math.max(1, Number(arg('attempts', '3')))
  const basePort = Number(arg('port', '9460'))
  /* `--ext=<目录>`：读哪个扩展目录的 ID（默认 = 探针，保持 Phase 1b 那条路不变） */
  const extDir = arg('ext', '')
  for (let i = 1; i <= attempts; i += 1) {
    const extId = await attempt({ profileName: `profile-extid-${i}`, port: basePort + i - 1, extDir })
    if (extId) {
      process.stdout.write(`${extId}\n`)
      return
    }
    note(`第 ${i}/${attempts} 轮没读到`)
  }
  note(`连续 ${attempts} 轮都读不到扩展 ID`)
  process.exit(1)
}

main().catch((error) => {
  note(`失败：${error.message}`)
  process.exit(1)
})
