import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   第 3 批（上）：脱敏做唯一真相（问题 24 延伸 + 三处判据统一）

    24 延伸  台账里 `commands[].command` / `.result` 还是明文 —— 而命令恰恰是
            密钥最常见的位置（`curl -H "Authorization: Bearer sk-…"`）
    三处判据 `memory-schema` 自己又写了一遍「原文 vs 脱敏后」的对比，
            与 `redact.looksSecret()` 是同一个逻辑的两份实现 → 收敛成一份

   出口/边界那几条在 batch2* / batch3Guards。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)

const taskCore = require_(join(ROOT, 'electron/core/task.cjs')) as {
  create: (options: Record<string, unknown>) => { id: string }
  get: (id: string) => { commands?: { command: string; result: string; exitOk: boolean }[] } | null
  addCommand: (id: string, command: string, result?: string) => unknown
  remove: (id: string) => void
}
const redact = require_(join(ROOT, 'electron/core/redact.cjs')) as {
  looksSecret: (text: unknown) => boolean
}
const memorySchema = require_(join(ROOT, 'electron/core/memory-schema.cjs')) as {
  looksLikeSecret: (text: unknown) => boolean
}

const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8')
const madeTasks: string[] = []

afterAll(() => {
  for (const id of madeTasks) {
    try {
      taskCore.remove(id)
    } catch {
      /* 忽略 */
    }
  }
})

/** 运行时拼串：完整密钥字面量会挡住 push（GitHub secret scanning） */
const fake = (...parts: string[]) => parts.join('')

describe('问题 24 延伸：台账里的命令与输出也要脱敏', () => {
  it('★ command 里的 Bearer / sk- 密钥写进台账前就打码了', () => {
    const bearer = fake('sk-', 'D'.repeat(40))
    const task = taskCore.create({ goal: '第3批：命令脱敏', sessionId: 'batch3-selftest' })
    madeTasks.push(task.id)

    taskCore.addCommand(
      task.id,
      `curl -H "Authorization: Bearer ${bearer}" https://api.example.com/v1`,
      `{"ok":true,"key":"${bearer}"}`,
    )

    const stored = taskCore.get(task.id)?.commands?.[0]
    expect(stored).toBeTruthy()
    expect(String(stored?.command)).not.toContain(bearer)
    expect(String(stored?.result)).not.toContain(bearer)
    expect(String(stored?.command)).toContain('已隐藏')
    /* 命令的形状还在（不是把整条命令删掉） */
    expect(String(stored?.command)).toContain('curl')
  })

  it('★ 先脱敏再截断：密钥被切一半也认得出（反着做会漏）', () => {
    const jwt = fake(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      '.',
      'E'.repeat(30),
      '.',
      'F'.repeat(30),
    )
    const task = taskCore.create({ goal: '第3批：截断顺序', sessionId: 'batch3-selftest' })
    madeTasks.push(task.id)

    /* 命令超长 → 会被截到 500 字；密钥如果先被切开，尾巴就会留在台账里 */
    taskCore.addCommand(task.id, `${'node '.repeat(120)}--token=${jwt}`, 'ok')

    const stored = String(taskCore.get(task.id)?.commands?.[0]?.command ?? '')
    expect(stored).not.toContain(jwt)
    expect(stored).not.toContain(jwt.slice(-20))
  })

  it('exitOk 仍然按**原文**判（脱敏不参与那条判据）', () => {
    const task = taskCore.create({ goal: '第3批：exitOk', sessionId: 'batch3-selftest' })
    madeTasks.push(task.id)

    taskCore.addCommand(task.id, 'npm test', '失败\n[退出码 1]')
    taskCore.addCommand(task.id, 'npm test', '通过\n[退出码 0]')

    const commands = taskCore.get(task.id)?.commands ?? []
    expect(commands[0]?.exitOk).toBe(false)
    expect(commands[1]?.exitOk).toBe(true)
  })

  it('读 commands 的那两处仍然工作（测试状态判据没被打断）', () => {
    /* 这两处按命令文本认「是不是测试命令」：脱敏不能把 `npm test` 改样 */
    expect(read('electron/core/task-outcome.cjs')).toContain('isTestCommand(item.command)')
    expect(read('electron/handlers/workspace.cjs')).toContain('isTestCommand(item.command)')
  })
})

describe('三处判据统一：判据只有 redact 一处', () => {
  it('★ memory-schema 的判据就是 redact.looksSecret 本身（不是又抄一遍）', () => {
    expect(memorySchema.looksLikeSecret).toBe(redact.looksSecret)
  })

  it('窄的那张老表认不出的，现在都认得出（7 类实证里抽 4 类）', () => {
    const samples = [
      fake('github_pat_', 'G'.repeat(24)),
      fake('AIza', 'H'.repeat(35)),
      fake('xoxb-', '1234567890-', 'I'.repeat(12)),
      fake('hf_', 'J'.repeat(34)),
      fake('', 'api_key=abcdef123456'),
      fake('', 'password: hunter2secret'),
    ]
    for (const sample of samples) {
      expect(memorySchema.looksLikeSecret(sample)).toBe(true)
      expect(redact.looksSecret(sample)).toBe(true)
    }
  })

  it('正常文本不误判（判据没变松）', () => {
    for (const text of [
      '把 README 的标题改短一点',
      '用 npm test 跑一遍',
      '记得带上 API 文档链接',
    ]) {
      expect(memorySchema.looksLikeSecret(text)).toBe(false)
    }
  })
})
