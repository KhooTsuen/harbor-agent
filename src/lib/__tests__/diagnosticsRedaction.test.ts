import { createRequire } from 'node:module'
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   诊断包：不能把明文密钥带出去（2026-10-04，问题 9）

   诊断包是「用户复制给开发者」的东西 —— 泄露一次就收不回来。

   改之前：`diagnostics.cjs` 自己写了两条**窄**正则（只认 `sk-` / `Bearer` /
   `api_key=`），比 `redact.cjs` 的模式表窄一大截。日志虽然写入时已过宽规则，
   但这道「第二层兜底」形同虚设 —— 两套规则会漂移。

   这一组钉两件事：
     ① 真跑一次 `build()`：塞进日志的「像密钥的串」在诊断包里**找不到**（被打了码）；
     ② 源码层面：判据只有一处（调 `redact()`），那份窄正则与零调用的 `mask()` 都已移除。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)

const diagnostics = require_(join(ROOT, 'electron/core/diagnostics.cjs')) as {
  build: () => { text: string; file: string }
}
const redact = require_(join(ROOT, 'electron/core/redact.cjs')) as {
  remember: (value: string, label?: string) => void
  forget: (value: string) => void
}

/** 假密钥一律**运行时拼串**：整串写在文件里会被 GitHub secret scanning 挡住 push */
const fake = (...parts: string[]) => parts.join('')

const PATTERN_SECRET = fake('github', '_pat_', 'F'.repeat(22)) // 老窄正则认不出这一类
const NAMED_SECRET = fake('sk-', 'diagnostics', '-test-', '9f2c7a41') // 走「记名法」那一条

/*
 * 日志文件名**直接跟内核要**（`log.dayStamp()` = 本地日期），这里不再自己拼一份。
 *
 * 这行原来是 `new Date().toISOString().slice(0,10)`（**UTC**）+ 一句「跟内核同一口径，
 * 对不上就让下面的断言红给我看」—— 2026-10-06 内核把 UTC 改成 `log.dayStamp()` 之后
 * 它确实红了（这条断言按设计干活了）。修法不是把日期抄两遍，而是**只有一处实现**。
 */
const logCore = require('../../../electron/core/log.cjs')
const todayLog = () => join(ROOT, 'data', 'logs', `${logCore.dayStamp()}.log`)

let originalSize = 0
const created: string[] = []

beforeAll(() => {
  originalSize = existsSync(todayLog()) ? statSync(todayLog()).size : 0
  redact.remember(NAMED_SECRET, '测试Key')
  /* 直接 append 到日志文件：模拟「由旧版本 / 别的路径写下的行」，绕开 log.cjs 的第一道脱敏 */
  appendFileSync(
    todayLog(),
    `[测试] 模式法：${PATTERN_SECRET}\n[测试] 记名法：${NAMED_SECRET}\n`,
    'utf8',
  )
})

afterAll(() => {
  /* 把日志截回原长度（连本轮 generate 写的 INFO 行一起去掉） */
  if (existsSync(todayLog())) truncateSync(todayLog(), originalSize)
  redact.forget(NAMED_SECRET)
  for (const f of created) if (existsSync(f)) rmSync(f)
})

describe('诊断包 / 明文密钥不能带出去', () => {
  it('★ 真跑一次 build()：塞进日志的两根密钥都不在包里', () => {
    const result = diagnostics.build()
    created.push(result.file)

    /* 前置：确认真塞进日志了（不然这条测试会「假绿」） */
    expect(existsSync(result.file)).toBe(true)
    expect(result.text).toContain('[测试]')

    expect(result.text).not.toContain(PATTERN_SECRET)
    expect(result.text).not.toContain(NAMED_SECRET)
    /* 而且确实打了码（不是把那几行整条丢掉） */
    expect(result.text).toContain('已隐藏')
  })

  it('★ 老窄正则认不出的那一类（github_pat_）也被打码了', () => {
    /* 这条是「改宽了」的回归：只认 sk-/Bearer/api_key= 的版本会漏它 */
    const line = `[测试] Authorization: Bearer ${PATTERN_SECRET}`
    appendFileSync(todayLog(), `${line}\n`, 'utf8')
    const result = diagnostics.build()
    created.push(result.file)
    expect(result.text).not.toContain(PATTERN_SECRET)
  })

  it('正常日志行不被误伤', () => {
    appendFileSync(todayLog(), '[测试] 这是一条普通日志，没有密钥\n', 'utf8')
    const result = diagnostics.build()
    created.push(result.file)
    expect(result.text).toContain('这是一条普通日志，没有密钥')
  })
})

describe('诊断包 / 判据只有一处', () => {
  const src = () => readFileSync(join(ROOT, 'electron/core/diagnostics.cjs'), 'utf8')

  it('★ 调的是 redact 主入口，不是自己写的正则', () => {
    const text = src()
    expect(text).toContain("require('./redact.cjs')")
    expect(text).toContain('redact.redact(')
  })

  it('★ 老那份窄正则已经没了（sk- / Bearer / api_key= 三条）', () => {
    const text = src()
    expect(text).not.toContain('(sk-|Bearer')
    expect(text).not.toContain('api[_-]?key"?')
  })

  it('★ 零调用的 mask() 已删除，导出里也没有它', () => {
    const text = src()
    expect(text).not.toContain('function mask')
    expect(text).not.toContain('module.exports = { build, mask }')
    expect(text).toContain('module.exports = { build }')
  })
})
