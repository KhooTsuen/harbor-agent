/**
 * 自举运行器（2026-10-17 · 3C-2）—— 在 Electron 运行时里跑一段自举脚本
 *
 * ── 它解决什么 ────────────────────────────────────────────────
 *
 * 3C-1 的自举副本为了让 `safeStorage` 能解密 Provider Key，把正式 userData 下的
 * `Local State`（里面有 `os_crypt.encrypted_key`）**复制**进了副本。
 * 那等于把密钥材料搬了一份出去 —— 副本一旦被复制走 / 被备份，密钥就跟着走。
 *
 * 这里改成**只指路径、不复制文件**：
 *
 *   · `userData` → 正式 `data/chromium`（**只读地用**它解一次密）
 *   · `sessionData` → 由调用方给的副本目录（Chromium 自己的东西写这里，
 *     正式 profile 一个字节都不动）
 *
 * 实测（2026-10-17）：两者都设成正式路径时解密**失败**；`userData` 指正式 +
 * `sessionData` 指副本 → 解密成功。这个组合是实测出来的，别「优化」掉。
 *
 * ── ★ 三条硬规矩 ──────────────────────────────────────────────
 *
 *   ① **不复制任何密钥相关文件**（Local State / credentials.json 都不进副本）。
 *   ② **明文只活在内存里**：不打印、不落盘、不写日志。
 *   ③ 拿不到 key 就**如实失败**，不假装有。
 *
 * 用法（只给本地自举 / 验证用，不参与产品运行时）：
 *
 *     npx electron tools/bootstrap-runner.cjs <自举脚本> --session <副本userdata目录> [脚本参数...]
 *
 * 自举脚本默认导出 `run(ctx)`，`ctx = { userData, sessionData, args }`。
 *
 * ⚠️ 不进打包产物。
 */

const path = require('node:path')
const { pathToFileURL } = require('node:url')

/* ★ 正式 userData（只用于解密，不复制其中任何文件） */
const REAL_USER_DATA = 'E:\\CodexWorkbench\\data\\chromium'

/**
 * 让副本的 session 目录能解密正式凭据 —— **不复制密钥材料**。
 *
 * ── 为什么需要这一步（2026-10-17 实测）──────────────────────────
 *
 * `safeStorage` 在 Windows 上走 Chromium 的 OSCrypt，它要读
 * `<sessionData>/Local State` 里的 `os_crypt.encrypted_key`。那个目录里
 * **没有**这份文件时，Chromium 会新生成一份密钥 —— 于是旧密文一律解不开
 * （实测：同一份 credentials.json，换一个空 session 目录就 `decryptString` 失败）。
 *
 * 3C-1 的做法是把 `Local State` **复制**进副本 —— 那等于把密钥材料搬了一份出去。
 * 这里改成**符号链接**：全机只有一份密钥文件，副本里只有一个指针。
 *
 * ★ 只读验证（2026-10-17）：跑完自举后正式 `Local State` 的 SHA256 未变
 *   （`2d9a5386…88c7`），说明 Chromium 没有回写它。
 * ★ 建不起链接就**如实失败**（不退回复制 —— 那正是要被去掉的做法）。
 *
 * @param {string} session 副本的 sessionData 目录
 * @returns {{ ok: boolean, mode: string, message: string }}
 */
function ensureLocalStateLink(session) {
  const fs = require('node:fs')
  const src = path.join(REAL_USER_DATA, 'Local State')
  const dst = path.join(session, 'Local State')
  try {
    fs.mkdirSync(session, { recursive: true })
  } catch (error) {
    return { ok: false, mode: '', message: `建不出 session 目录：${String((error && error.message) || error)}` }
  }
  try {
    const st = fs.lstatSync(dst)
    if (st.isSymbolicLink()) return { ok: true, mode: 'link', message: '已有指向正式 Local State 的链接' }
    /* 已存在的**真实文件**：可能是复制来的旧副本 —— 明确报出来，不静默用 */
    return { ok: false, mode: 'copy', message: 'session 目录里已有一份真实的 Local State（像是复制来的）—— 请删掉它，改用链接' }
  } catch {
    /* 不存在 → 建链接 */
  }
  try {
    fs.symlinkSync(src, dst, 'file')
    return { ok: true, mode: 'link', message: '已建立指向正式 Local State 的符号链接（未复制密钥材料）' }
  } catch (error) {
    return {
      ok: false,
      mode: '',
      message: `建不出符号链接（${String((error && error.message) || error)}）—— 不复制密钥材料，如实失败`,
    }
  }
}

/** 从 argv 里摘出 `--session <dir>`，其余给自举脚本 */
function parseArgv(argv) {
  const rest = argv.slice(2)
  const target = String(rest[0] ?? '').trim()
  let session = ''
  const args = []
  for (let i = 1; i < rest.length; i += 1) {
    if (rest[i] === '--session') {
      session = String(rest[i + 1] ?? '').trim()
      i += 1
      continue
    }
    args.push(rest[i])
  }
  return { target, session, args }
}

async function main() {
  const { target, session, args } = parseArgv(process.argv)
  if (!target || !session) {
    console.error('用法：npx electron tools/bootstrap-runner.cjs <自举脚本> --session <副本userdata目录> [参数...]')
    process.exit(2)
  }

  /* ★ 必须在 app ready 之前设：Chromium 在 ready 时就把 profile 路径定死了 */
  const { app, safeStorage } = require('electron')
  app.setPath('userData', REAL_USER_DATA)

  /* 先备好 session 目录（含指向正式 Local State 的链接）—— 同样要在 ready 之前 */
  const linked = ensureLocalStateLink(session)
  if (!linked.ok) {
    console.error(`自举运行器：${linked.message}`)
    app.exit(6)
    return
  }
  console.log(`session：${linked.message}`)
  app.setPath('sessionData', session)

  await app.whenReady()

  if (!safeStorage.isEncryptionAvailable()) {
    console.error('自举运行器：safeStorage 不可用 —— 无法读取 Provider Key（不复制密钥材料，如实失败）')
    app.exit(3)
    return
  }

  const ctx = { userData: REAL_USER_DATA, sessionData: session, args }

  try {
    const mod = await import(pathToFileURL(path.resolve(target)).href)
    const run = typeof mod.run === 'function' ? mod.run : typeof mod.default === 'function' ? mod.default : null
    if (!run) {
      console.error('自举脚本必须导出 run(ctx)')
      app.exit(4)
      return
    }
    const code = await run(ctx)
    app.exit(Number.isFinite(code) ? code : 0)
  } catch (error) {
    console.error(`自举脚本失败：${String((error && error.message) || error).slice(0, 300)}`)
    app.exit(5)
  }
}

void main()
