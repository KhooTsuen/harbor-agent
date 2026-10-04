import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   第 2 批（上）：边界（审计问题 14 / 15 / 16 / 17）

    14 备份名拼路径 → `remove('../sessions')` 能删掉会话目录
    15 会话 id 拼路径 → `session:read` 四个通道共用一个 fileFor
    16 超时只杀 cmd.exe，命令的孙子变孤儿继续跑
    17 run_shell 的 cwd 是裸的（文件工具有权限边界，shell 没有）

   出口那四条（20 / 21 / 23 / 24）在 batch2Exits.test.ts。
   问题 16 那条是**真跑一遍**：只看函数返回的文案，改不改 killTree 都是绿的。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)
const SANDBOX = mkdtempSync(join(tmpdir(), 'harbor-batch2a-'))

/* ★ 沙盒注入口：来由见 batch1DataLoss.test.ts 顶部（CI 上没有仓库 data/，没注入口就会读写它） */
const paths = require_(join(ROOT, 'electron/core/paths.cjs')) as {
  DIRS: { sessions: string }
  markPackaged: (base: string) => void
  ensureDirs: () => void
}
paths.markPackaged(SANDBOX)
paths.ensureDirs()
const { DIRS } = paths
const sessionIo = require_(join(ROOT, 'electron/core/session-io.cjs')) as {
  fileFor: (id: string) => string
  isSessionId: (id: unknown) => boolean
  newId: () => string
  writeLines: (id: string, lines: unknown[]) => void
}
const sessionRead = require_(join(ROOT, 'electron/core/session-read.cjs')) as {
  list: () => { id: string }[]
}
const backup = require_(join(ROOT, 'electron/core/backup.cjs')) as {
  restore: (name: string) => { ok: boolean; error?: string }
  remove: (name: string) => { ok: boolean; error?: string }
}
const runShell = require_(join(ROOT, 'electron/core/tools/run_shell.cjs')) as {
  run: (args: Record<string, unknown>, ctx: unknown) => Promise<string>
}
const taskOutcome = require_(join(ROOT, 'electron/core/task-outcome.cjs')) as {
  exitOf: (raw: string) => boolean
}

const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8')

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('问题 15：会话 id 白名单（四个通道共用的那一处）', () => {
  it('带路径分隔符 / .. 的 id 直接拒绝，不拼路径', () => {
    for (const bad of ['..\\..\\config', '../../config', '', 'no-such-session-xyz', 'sess_A1B2']) {
      expect(() => sessionIo.fileFor(bad)).toThrow(/不合法/)
    }
  })

  it('自己的 id 照旧能用', () => {
    const id = sessionIo.newId()
    expect(sessionIo.fileFor(id).endsWith(`${id}.jsonl`)).toBe(true)
    expect(sessionIo.isSessionId(id)).toBe(true)
  })

  it('★ 会话列表遇到不合规的文件名不崩（跳过它）', () => {
    /* 先放一个**合规**的会话：以前这条靠仓库 data/sessions 里恰好有东西，
       CI 上是空的 → `expected 0 to be greater than 0` */
    sessionIo.writeLines(sessionIo.newId(), [{ type: 'meta', title: '沙盒里的正常会话' }])
    const stray = join(DIRS.sessions, 'zzz-not-ours-1.jsonl')
    writeFileSync(stray, '{"type":"meta","title":"不是我们的文件"}\n', 'utf8')
    try {
      const listed = sessionRead.list()
      expect(listed.some((item) => item.id === 'zzz-not-ours-1')).toBe(false)
      expect(listed.length).toBeGreaterThan(0)
    } finally {
      rmSync(stray, { force: true })
    }
  })
})

describe('问题 14：备份名白名单（restore / remove 不再拼任意路径）', () => {
  it('穿越名字被拒，且**没碰**数据目录', () => {
    const before = existsSync(DIRS.sessions)

    const restored = backup.restore('..\\..\\Windows')
    expect(restored.ok).toBe(false)
    expect(String(restored.error)).toContain('不合法')

    const removed = backup.remove('..\\sessions')
    expect(removed.ok).toBe(false)

    /* 真断言：会话目录还在（以前 remove('../sessions') 会把它删掉） */
    expect(existsSync(DIRS.sessions)).toBe(before)
  })

  it('合规但不存在的时间戳名 → 仍走「找不到」，不是「不合法」', () => {
    const r = backup.restore('19700101-000000')
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('找不到')
  })
})

describe('问题 16：超时/中断连子树一起杀', () => {
  it('超时文案仍能被 task-outcome 认成「失败」（跨模块钉子）', () => {
    expect(taskOutcome.exitOf('[进程被超时杀掉（5s）：已连同子进程一起终止]')).toBe(false)
    expect(taskOutcome.exitOf('正常结果\n[退出码 0]')).toBe(true)
  })

  it('接线：内核不再把超时交给 exec，也不再直接 kill 直接子进程', () => {
    const runShellSrc = read('electron/core/tools/run_shell.cjs')
    expect(runShellSrc).not.toContain('timeout: timeoutSec * 1000')
    expect(runShellSrc).toContain('killTree(child)')

    const shellHandler = read('electron/handlers/shell.cjs')
    expect(shellHandler).not.toContain('child.kill(')
    expect((shellHandler.match(/killTree\(/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it.skipIf(process.platform !== 'win32')(
    '★ 真跑：超时之后，命令生出来的孙子进程也死了',
    async () => {
      const script = join(SANDBOX, 'grandchild.cjs')
      const pidFile = join(SANDBOX, 'grandchild.pid')
      writeFileSync(
        script,
        [
          "const { spawn } = require('node:child_process')",
          "const fs = require('node:fs')",
          "const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {",
          '  stdio: "ignore",',
          '})',
          'fs.writeFileSync(process.argv[2], String(kid.pid), "utf8")',
          'setTimeout(() => {}, 30000)',
        ].join('\n'),
        'utf8',
      )

      const result = await runShell.run(
        { command: `node "${script}" "${pidFile}"`, timeout: 5 },
        { workdir: SANDBOX, sessionId: 'batch2', permission: 'full' },
      )
      expect(String(result)).toContain('进程被超时杀掉')
      expect(existsSync(pidFile)).toBe(true)

      const pid = readFileSync(pidFile, 'utf8').trim()
      /* taskkill 是异步的（spawn 完就返回），给它一点时间落地 */
      await new Promise((resolve) => setTimeout(resolve, 2000))
      expect(alive(pid)).toBe(false)
    },
    20000,
  )
})

describe('问题 17：run_shell 的执行目录也过权限边界', () => {
  it('工作目录外 → 需要授权（不是默默跑掉）', async () => {
    /* 以前写的是 'C:\Windows' —— 那个路径只在 Windows 上算「工作目录外」；
       CI 跑 Linux，它会被当成相对路径（落在工作目录里）→ 权限门放行
       → 断言就变成了 `promise resolved instead of rejecting`。
       改成沙盒的同级目录：两个平台都在工作目录之外。 */
    const outside = mkdtempSync(join(tmpdir(), 'harbor-outside-'))
    await expect(
      runShell.run({ command: 'echo hi', cwd: outside }, { workdir: SANDBOX, sessionId: 'batch2' }),
    ).rejects.toThrow(/需要授权/)
  })

  it('工作目录内照常执行，并把**实际** cwd 回填给审计', async () => {
    const args: Record<string, unknown> = { command: 'echo batch2-ok' }
    const out = await runShell.run(args, { workdir: SANDBOX, sessionId: 'batch2' })

    expect(String(out)).toContain('batch2-ok')
    expect(typeof args.cwd).toBe('string')
    expect(String(args.cwd).length).toBeGreaterThan(0)
  })
})

/** 那个 pid 还在不在（Windows 专用） */
function alive(pid: string): boolean {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' })
    return out.includes(pid)
  } catch {
    return false
  }
}
