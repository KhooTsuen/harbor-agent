import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   looksSecret：判据要稳、宽窄不能变（2026-10-04）

   它原来自己遍历 PATTERNS 做 `.test()`，而那些正则大多带 `/g` ——
   `test()` 会把 `lastIndex` 留在正则对象上，于是**同一根字符串连判两次结果会翻**：

     looksSecret('password: hunter2secret') 连判 5 次 → [true,false,true,false,true]

   拿它当门禁（记忆写入 / 定时任务创建）时，「拦不拦得住」就取决于上一次判的是哪根字符串。
   现在改成走 `redact()` 主入口（原文 vs 脱敏后对比），判据与脱敏同一处。

   这一组钉四件事：
     ① 稳定：同串连判、交叉判都不翻；
     ② 没变松：原来认得出的（sk- / Bearer / github_pat_ / JWT / 私钥块 / URL 凭据）照样认得出；
     ③ 没变严：正常句子不被误判；
     ④ 登记过的真密钥（记名法）也照样认得出。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)

const redact = require_(join(ROOT, 'electron/core/redact.cjs')) as {
  looksSecret: (text: unknown) => boolean
  remember: (value: string, label?: string) => void
  forget: (value: string) => void
}

/** 假密钥一律运行时拼串（整串写进文件会被 GitHub secret scanning 挡 push） */
const fake = (...parts: string[]) => parts.join('')

/** 原来那套「窄的也能认出来」的样本 —— 修 bug 不许把这些弄丢 */
const STILL_SECRET: [string, string][] = [
  ['OpenAI 风格', fake('sk-', 'abcdefghijklmnopqrstuvwxyz012345')],
  ['Bearer 头', fake('Authorization: Bearer ', 'abc123def456ghi789jkl')],
  ['GitHub 细粒度 PAT', fake('github', '_pat_', 'E'.repeat(24))],
  ['JWT', fake('eyJ', 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.', 'G'.repeat(20))],
  ['字段式 api_key=', fake('api_key=', 'abcdef123456')],
  ['URL 里的凭据', fake('https://user:', 'p4ssw0rd@example.com/')],
  ['私钥块', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'],
]

const NORMAL = [
  '用户喜欢简短回复，不要长篇',
  '项目 A 用 vitest 跑单测',
  'password 字段怎么校验比较稳',
  '把 key 写进 credentials.json，别写进 config.json',
]

describe('looksSecret / 判据必须无状态', () => {
  it('★ 同一根字符串连判 5 次，结果一致', () => {
    const s = fake('password: ', 'hunter2secret')
    const runs = Array.from({ length: 5 }, () => redact.looksSecret(s))
    expect(new Set(runs).size).toBe(1)
    expect(runs[0]).toBe(true)
  })

  it('★ 交叉判（长 → 短 → 长）不受影响', () => {
    const a = fake('github', '_pat_', 'E'.repeat(24))
    const b = fake('sk-', 'short1234567890abcdef')
    expect([redact.looksSecret(a), redact.looksSecret(b), redact.looksSecret(a)]).toEqual([
      true,
      true,
      true,
    ])
  })

  it('★ 连判一串混合样本，每根都稳定', () => {
    const seq = [...STILL_SECRET.map(([, v]) => v), ...STILL_SECRET.map(([, v]) => v)]
    const first = seq.map((v) => redact.looksSecret(v))
    const second = seq.slice(STILL_SECRET.length).map((v) => redact.looksSecret(v))
    expect(second).toEqual(first.slice(STILL_SECRET.length))
  })
})

describe('looksSecret / 没变松也没变严', () => {
  for (const [label, text] of STILL_SECRET) {
    it(`原来认得出，现在照样认得出：${label}`, () => {
      expect(redact.looksSecret(text)).toBe(true)
    })
  }

  for (const text of NORMAL) {
    it(`正常内容不误判：${text.slice(0, 12)}…`, () => {
      expect(redact.looksSecret(text)).toBe(false)
    })
  }

  it('登记过的真密钥（记名法）照样认得出', () => {
    const named = fake('mysupersecretvalue', '0123456')
    redact.remember(named, '测试')
    try {
      expect(redact.looksSecret(`随便一句里夹着 ${named} 这样`)).toBe(true)
    } finally {
      redact.forget(named)
    }
    /* 忘掉之后不再当它是密钥（readme: 用户换了 key 就该释放） */
    expect(redact.looksSecret(`随便一句里夹着 ${named} 这样`)).toBe(false)
  })

  it('空串 / 非字符串不许炸', () => {
    expect(redact.looksSecret('')).toBe(false)
    expect(redact.looksSecret(null)).toBe(false)
    expect(redact.looksSecret(undefined)).toBe(false)
  })
})

describe('looksSecret / 判据只有一处（源码级）', () => {
  const src = () => readFileSync(join(ROOT, 'electron/core/redact.cjs'), 'utf8')

  it('★ 走的是 redact 主入口，不再自己 test 模式表', () => {
    const text = src()
    expect(text).toContain('return redact(sample) !== sample')
  })

  it('★ 模式表（PATTERNS）一个字没动：仍然有那些厂商前缀', () => {
    const text = src()
    for (const needle of ['github_pat_', 'AIza', 'xox[baprs]-', 'hf_', 'AKIA', 'eyJ']) {
      expect(text).toContain(needle)
    }
  })
})
