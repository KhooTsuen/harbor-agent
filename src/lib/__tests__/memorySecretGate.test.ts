import { createRequire } from 'node:module'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   记忆的密钥门禁：判据只准有一处（2026-10-04，自举第一次真实改动）

   以前 `memory-schema.cjs` 自己抄了一张 5 条的窄表（只认 sk- / gh[pousr]_ /
   AKIA / 私钥块 / Bearer），而 `redact.cjs` 那张表宽得多。只读审计实测：
   下面 7 类都能**写进记忆**。而记忆是**每轮注入上下文**的 ——
   漏一条 = 每轮都泄露，还会跟着备份一起走。

   这一组钉三件事：
     ① 那 7 类在**门禁**上被拒（不是只在脱敏函数上被认出）；
     ② 正常内容不被误拒（否则修复会把用户的记忆功能弄坏）；
     ③ 判据只有一处：`memory-schema` 不再有自己那张表，两个消费者都用它。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)

const schema = require_(join(ROOT, 'electron/core/memory-schema.cjs')) as {
  looksLikeSecret: (text: unknown) => boolean
}
const store = require_(join(ROOT, 'electron/core/memory-store.cjs')) as {
  add: (input: { content: string }) => { ok: boolean; error?: string; item?: { id: string } }
  filePath: () => string
}

/**
 * 造一根「形状对」的假密钥：**不把整串写在文件里**。
 *
 * 为什么要拆：完整字面量会被 GitHub 的 secret scanning 当成真密钥，push 直接被拒
 * （2026-10-04 实测：「To push, remove secret from commit(s)」）。
 * 拆成几段拼出来，文件里就只是一堆普通字符串 —— 而运行时造出来的那根照样过判据。
 */
const fake = (...parts: string[]) => parts.join('')

/** 审计里实测能混进记忆的 7 类（每类的形态都按真实厂商格式拼） */
const SECRETS: [string, string][] = [
  ['github_pat_（细粒度 PAT）', fake('github', '_pat_', 'A'.repeat(22))],
  ['AIza（Google API Key）', fake('AI', 'za', 'B'.repeat(33))],
  ['xoxb-（Slack Bot Token）', fake('xox', 'b-', '123456789012-', 'abcdefghijklmnop')],
  ['hf_（HuggingFace Token）', fake('h', 'f_', 'C'.repeat(32))],
  ['JWT', fake('eyJ', 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.', 'D'.repeat(20))],
  ['api_key=xxx（字段式）', fake('api_key=', 'abcdef123456')],
  ['password: xxx（字段式）', fake('password: ', 'hunter2secret')],
]

/** 正常内容：一个都不该被拒 */
const NORMAL = [
  '用户喜欢简短回复，不要长篇',
  '项目 A 用 vitest 跑单测',
  'password 字段怎么校验比较稳',
  '把 key 写进 credentials.json，别写进 config.json',
]

/* 门禁放行的那条会真写记忆文件 —— 先存整份，跑完原样放回（这个仓库里没有别的
   src 测试碰 memory.json，所以不会被并发踩） */
const memPath = store.filePath()
let snapshot: string | null = null

beforeAll(() => {
  snapshot = existsSync(memPath) ? readFileSync(memPath, 'utf8') : null
})

afterAll(() => {
  if (snapshot === null) {
    if (existsSync(memPath)) rmSync(memPath)
  } else {
    writeFileSync(memPath, snapshot, 'utf8')
  }
})

describe('记忆密钥门禁 / 7 类必须被拒', () => {
  for (const [label, text] of SECRETS) {
    it(`★ 判据认得出：${label}`, () => {
      expect(schema.looksLikeSecret(text)).toBe(true)
    })

    it(`★ 门禁拦得住：${label}`, () => {
      const res = store.add({ content: `${label} 的示例：${text}` })
      expect(res.ok).toBe(false)
      expect(String(res.error ?? '')).toContain('密钥')
    })
  }
})

describe('记忆密钥门禁 / 判据必须无状态', () => {
  /*
   * 这条是本次红出来的真问题：`redact.looksSecret()` 拿**带 /g 的正则**做 `.test()`，
   * 会留下 lastIndex —— 同一根字符串连判两边结果交替翻
   * （实测 `[true,false,true,false,true]`）。门禁要是用了它，
   * 「能不能拦住」就取决于上一次判的是哪根字符串了。
   */
  it('★ 同一根字符串连判 5 次，结果必须一致', () => {
    const runs = Array.from({ length: 5 }, () =>
      schema.looksLikeSecret(fake('password: ', 'hunter2secret')),
    )
    expect(new Set(runs).size).toBe(1)
    expect(runs[0]).toBe(true)
  })

  it('★ 交叉判也不受影响（长串 → 短串 → 长串）', () => {
    const long = fake('示例：github', '_pat_', 'A'.repeat(22))
    const short = fake('h', 'f_', 'C'.repeat(32))
    const seq = [
      schema.looksLikeSecret(long),
      schema.looksLikeSecret(short),
      schema.looksLikeSecret(long),
    ]
    expect(seq).toEqual([true, true, true])
  })
})

describe('记忆密钥门禁 / 反向：正常内容不误拒', () => {
  for (const text of NORMAL) {
    it(`判据不误伤：${text.slice(0, 14)}…`, () => {
      expect(schema.looksLikeSecret(text)).toBe(false)
    })
  }

  it('★ 正常内容真的能存下来（门禁放行这条才是「没弄坏功能」）', () => {
    const res = store.add({ content: '自举验证：这是一条正常内容（跑完会把记忆文件还原）' })
    expect(res.ok).toBe(true)
    expect(res.item?.id).toBeTruthy()
  })
})

describe('记忆密钥门禁 / 判据只有一处', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

  it('★ memory-schema 不再有自己那张表，改用 redact 的模式表', () => {
    const src = read('electron/core/memory-schema.cjs')
    expect(src).not.toContain('SECRET_LIKE')
    expect(src).toContain('redact.looksSecret')
  })

  it('★ 记忆写入的两处门禁都用共享判据', () => {
    const src = read('electron/core/memory-store.cjs')
    expect(src).not.toContain('SECRET_LIKE')
    /* add() 与 update() 各一处 */
    expect((src.match(/looksLikeSecret\(/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('★ 另一个消费者（定时任务）也用同一份判据，不再自己实现一份', () => {
    const src = read('electron/core/schedule-store.cjs')
    expect(src).not.toContain('SECRET_LIKE')
    /* 它原来是「自己那张窄表 + redact.looksSecret」两道 —— 现在直接引 memory-schema 的那一份 */
    expect(src).toContain("require('./memory-schema.cjs')")
    expect(src).toContain('looksLikeSecret')
    expect(src).not.toContain('redact.looksSecret')
  })
})
