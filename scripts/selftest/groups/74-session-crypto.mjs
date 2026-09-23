/*
   会话内容加密（session-crypto.cjs）以及它在 session-io.cjs 上的接线。

   钉子清单：
     · 未启用时**行为一点不变**（sealLine / openLine 原样返回）—— 回归钉子
     · 启用后：封印 → 解封得回原文；密文里**看不见**原文关键词
     · 老数据（明文）在启用状态下照样能读 —— 迁移没跑完也不至于读不出来
     · 单行损坏 → 只丢那一行，会话其余内容照读
     · sealLine 幂等（不双重加密）；密钥拿不到时**绝不回落明文**
     · 迁移：先备份 → 加密 → 解密 → 与最初逐字节一致；备份失败、或有一行解不开，
       都必须中止且**不动原文件**（原子）
     · ★ 全程**绝不碰用户真实数据**：假凭证 + 沙箱目录；跑完真实 data/sessions
       的文件数与总字节必须与开始时一模一样

   ⚠️ 这一组不改用户的 config.json / credentials.json：config.get 与 credentials.get/set
      都临时换成假的，finally 里还原。沙箱在 data/selftest-workspace/session-crypto。
   ⚠️ `scripts/selftest.mjs` 还没注册这一组（主代理加一行 import + GROUPS 即可）。
*/

import { check, group } from '../harness.mjs'
import { join, mkdirSync, readFileSync, require, rmSync, ROOT, writeFileSync } from '../env.mjs'

const fs = require('node:fs')
const crypto = require('node:crypto')
const sessionCrypto = require(join(ROOT, 'electron/core/session-crypto.cjs'))
const sessionIO = require(join(ROOT, 'electron/core/session-io.cjs'))
const configModule = require(join(ROOT, 'electron/core/config.cjs'))
const configNormalize = require(join(ROOT, 'electron/core/config-normalize.cjs'))
const credentialCore = require(join(ROOT, 'electron/core/credentials.cjs'))
const secCfg = require(join(ROOT, 'electron/core/config-security.cjs'))

const SANDBOX = join(ROOT, 'data', 'selftest-workspace', 'session-crypto')
const REAL = join(ROOT, 'data', 'sessions')

/** 真实 data/sessions 的（文件数, 总字节）—— 用来钉「绝不动真数据」 */
function snapshot() {
  let names = []
  try {
    names = fs.readdirSync(REAL).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return { count: 0, bytes: 0 }
  }
  let bytes = 0
  for (const name of names) bytes += fs.statSync(join(REAL, name)).size
  return { count: names.length, bytes }
}

/** 非空行（迁移测试里反复用） */
const linesOf = (text) => text.split('\n').filter((line) => line.trim())

/** 把一行密文中间改一个字符：base64 仍合法，但 GCM 认证必然失败 */
function corrupt(line) {
  const body = [...line.slice(3)]
  const at = Math.floor(body.length / 2)
  body[at] = body[at] === 'A' ? 'B' : 'A'
  return `e1:${body.join('')}`
}

const KEY = crypto.randomBytes(32).toString('base64')
const store = new Map()
const backups = []

export async function run() {
  const before = snapshot()
  let sealedSample = ''

  /* 假凭证库（**绝不碰真 credentials.json**）与假开关（**绝不碰真 config.json**） */
  const realGet = credentialCore.get
  const realSet = credentialCore.set
  const realConfigGet = configModule.get
  const enable = (on) => {
    configModule.get = () => ({ security: { encryptSessions: on === true } })
  }
  credentialCore.get = (ref) => store.get(ref) ?? ''
  credentialCore.set = (ref, value) => {
    store.set(ref, String(value))
    return { ok: true }
  }

  try {
    group('会话加密 / 未启用时行为不变（回归钉子）')
    enable(false)
    sessionCrypto._resetKeyCache()
    check('PREFIX 就是 e1:', sessionCrypto.PREFIX === 'e1:')
    check('★ 未启用：sealLine 原样返回', sessionCrypto.sealLine('{"a":1}') === '{"a":1}')
    check('★ 未启用：openLine 原样返回', sessionCrypto.openLine('{"a":1}') === '{"a":1}')
    check(
      '★ 未启用：serializeLine 不带前缀（老行为不变）',
      !sessionIO.serializeLine({ type: 'meta', title: 'x' }).startsWith('e1:'),
    )
    check('未启用也能查密钥状态（不抛错）', typeof sessionCrypto.keyInfo().available === 'boolean')

    group('会话加密 / 启用后的封印与解封')
    store.set('session:master', KEY)
    sessionCrypto._resetKeyCache()
    enable(true)
    const sample = '{"text":"中文 😀 秘密内容","nl":"a\\nb"}'
    sealedSample = sessionCrypto.sealLine(sample)
    check('★ 启用后带 e1: 前缀', sealedSample.startsWith('e1:'), sealedSample.slice(0, 12))
    check('★ 解封得回原文（含中文 / emoji / 换行）', sessionCrypto.openLine(sealedSample) === sample)
    check('openLineDetailed 的 ok 是 true', sessionCrypto.openLineDetailed(sealedSample).ok === true)
    check('★ 同一输入两次密文不同（IV 随机）', sessionCrypto.sealLine(sample) !== sealedSample)
    check('密钥状态报可用', sessionCrypto.keyInfo().available === true)

    group('会话加密 / 密文里看不见内容')
    const probes = ['sk-', '秘密内容', 'Bearer']
    const mixed = sessionCrypto.sealLine(
      JSON.stringify({ apiKey: 'sk-live-123', content: '秘密内容', h: 'Bearer abc' }),
    )
    const leaked = probes.filter((probe) => mixed.includes(probe))
    check('★ 密文里不含任何探针关键词', leaked.length === 0, leaked.join(' , '))
    check('密文是纯 ASCII base64（没有原文残渣）', /^e1:[A-Za-z0-9+/=]+$/.test(mixed))

    group('会话加密 / 接线：session-io 是「先脱敏再封印」')
    const wired = sessionIO.serializeLine({ type: 'message', content: '接线检查', apiKey: 'sk-wired-999' })
    check('★ serializeLine 启用后带前缀', wired.startsWith('e1:'))
    const wiredBack = sessionCrypto.openLine(wired)
    check('★ 解回来还是同一个对象', JSON.parse(wiredBack).content === '接线检查')
    check('★ 密钥先被脱敏掉了（明文里不再有 sk-）', !wiredBack.includes('sk-wired-999'), wiredBack)

    group('会话加密 / 老数据（明文）兼容与幂等')
    check('★ 启用状态下明文行照样读得回', sessionCrypto.openLine('{"type":"message"}') === '{"type":"message"}')
    check('明文行的 openLineDetailed 是 ok', sessionCrypto.openLineDetailed('{"t":1}').ok === true)
    check('★ 对已封的行再封印：原样返回（不套两层）', sessionCrypto.sealLine(sealedSample) === sealedSample)
    check(
      '★ 解开一次就是原文（没有 double-encrypt）',
      sessionCrypto.openLine(sessionCrypto.sealLine(sealedSample)) === sample,
    )

    group('会话加密 / 单行损坏只丢那一行')
    const broken = sessionCrypto.openLineDetailed(corrupt(sealedSample))
    check('★ 损坏行 ok === false', broken.ok === false)
    check('★ 错误是人话（说了「解不开」）', /解不开/.test(broken.error), broken.error)
    check('损坏行的 openLine 返回空串（不是原文、不是密文）', sessionCrypto.openLine(corrupt(sealedSample)) === '')

    /* 接线：一行坏了不能让整个会话读不出来（临时文件，finally 里删掉） */
    const tmpId = 'selftest-crypto-broken'
    const tmpFile = sessionIO.fileFor(tmpId)
    try {
      writeFileSync(
        tmpFile,
        [
          sessionIO.serializeLine({ type: 'meta', id: tmpId, title: '自检' }),
          corrupt(sessionCrypto.sealLine(JSON.stringify({ type: 'message', content: '坏行' }))),
          sessionIO.serializeLine({ type: 'message', content: '好行' }),
        ].join('\n') + '\n',
        'utf8',
      )
      const rows = sessionIO.readLines(tmpId)
      check('★ 一行解不开时其余行照读（不是整个会话读不出来）', rows.length === 2, String(rows.length))
      check('读回的就是那两个对象', rows[0]?.type === 'meta' && rows[1]?.content === '好行')
    } finally {
      rmSync(tmpFile, { force: true })
    }

    group('会话加密 / 迁移：先备份、可重入、内容可还原')
    rmSync(SANDBOX, { recursive: true, force: true })
    mkdirSync(SANDBOX, { recursive: true })
    const names = ['sess_fake1.jsonl', 'sess_fake2.jsonl']
    const origin = {}
    names.forEach((name, index) => {
      origin[name] =
        [
          JSON.stringify({ type: 'meta', id: `sess_fake${index + 1}`, title: `假会话 ${index + 1}` }),
          JSON.stringify({ type: 'message', role: 'user', content: index === 0 ? '你好 😀' : '第二份内容' }),
        ].join('\n') + '\n'
      writeFileSync(join(SANDBOX, name), origin[name], 'utf8')
    })
    const fakeBackup = (why) => {
      backups.push(why)
      return { ok: true, name: `fake-backup-${why}` }
    }

    const on = sessionCrypto.migrate({ enable: true, dir: SANDBOX, backupFn: fakeBackup })
    check('★ 加密迁移成功', on.ok === true, on.error ?? '')
    check('★ 先备份，理由写明是「加密前」', backups[0] === 'before-session-encrypt', backups.join(','))
    check('★ 返回值带备份名（界面要能告诉用户去哪找）', on.backup === 'fake-backup-before-session-encrypt', on.backup)
    check('两个文件都转换了', on.files === 2 && on.converted.length === 2, JSON.stringify(on.converted))
    check('转换了 4 行（2 文件 × 2 行）', on.lines === 4, String(on.lines))
    const encrypted = names.map((name) => readFileSync(join(SANDBOX, name), 'utf8'))
    check('★ 盘上每行都带 e1: 前缀', encrypted.every((text) => linesOf(text).every((l) => l.startsWith('e1:'))))
    check('★ 盘上已看不到原文关键词', encrypted.every((text) => !text.includes('你好') && !text.includes('假会话')))
    check(
      '★ 逐行解回来与最初一致',
      encrypted.every((text, i) =>
        linesOf(text).every((line, li) => sessionCrypto.openLine(line) === linesOf(origin[names[i]])[li]),
      ),
    )

    const off = sessionCrypto.migrate({ enable: false, dir: SANDBOX, backupFn: fakeBackup })
    check('★ 解密迁移成功', off.ok === true, off.error ?? '')
    check('★ 停用方向也先备份（理由「解密前」）', backups.at(-1) === 'before-session-decrypt')
    check(
      '★ 回到明文，且与最初**逐字节一致**',
      names.every((name) => readFileSync(join(SANDBOX, name), 'utf8') === origin[name]),
    )

    const again = sessionCrypto.migrate({ enable: false, dir: SANDBOX, backupFn: fakeBackup })
    check('★ 可重入：同方向第二遍 ok、failed 0', again.ok === true && again.failed === 0, JSON.stringify(again))
    check('★ 可重入：没有文件需要改（files 0）', again.files === 0 && again.lines === 0)
    check('★ 可重入：不白做一次备份', again.backup === '')
    check(
      '可重入：内容依然逐字节一致',
      names.every((name) => readFileSync(join(SANDBOX, name), 'utf8') === origin[name]),
    )

    group('会话加密 / 迁移失败必须中止且不动原文件')
    sessionCrypto.migrate({ enable: true, dir: SANDBOX, backupFn: fakeBackup })
    const blocked = sessionCrypto.migrate({
      enable: false,
      dir: SANDBOX,
      backupFn: () => ({ ok: false, error: '磁盘满了' }),
    })
    check('★ 备份失败 → 中止（ok: false）', blocked.ok === false)
    check('★ 中止时一个文件都没动', blocked.files === 0 && blocked.converted.length === 0)
    check(
      '★ 理由是人话且带上备份失败原因',
      /备份失败/.test(blocked.error) && blocked.error.includes('磁盘满了'),
      blocked.error,
    )
    check(
      '★ 中止后内容仍是密文（没有被半途改成明文）',
      linesOf(readFileSync(join(SANDBOX, names[0]), 'utf8')).every((l) => l.startsWith('e1:')),
    )

    const target = join(SANDBOX, names[0])
    const rows = linesOf(readFileSync(target, 'utf8'))
    rows[1] = corrupt(rows[1])
    writeFileSync(target, `${rows.join('\n')}\n`, 'utf8')
    const beforeBad = readFileSync(target, 'utf8')
    const atomic = sessionCrypto.migrate({ enable: false, dir: SANDBOX, backupFn: fakeBackup })
    check('★ 有一行解不开 → 报告失败（不静默丢数据）', atomic.ok === false && atomic.failed === 1, atomic.error ?? '')
    check('★ 失败时那个文件一个字节都没动（原子）', readFileSync(target, 'utf8') === beforeBad)

    group('会话加密 / 密钥拿不到时绝不回落明文')
    store.delete('session:master')
    sessionCrypto._resetKeyCache()
    credentialCore.get = () => {
      throw new Error('模拟 safeStorage 解不开（换了 Windows 账户）')
    }
    let thrown = ''
    try {
      sessionCrypto.sealLine('{"secret":1}')
    } catch (error) {
      thrown = error.message
    }
    check('★ 启用状态下拿不到密钥 → sealLine 抛错（绝不静默写明文）', thrown.length > 0, thrown)
    check(
      '★ 错误是人话（读不出来 + 说清原因）',
      /读不出来/.test(thrown) && /Windows 账户|拷到别的机器/.test(thrown),
      thrown,
    )
    const info = sessionCrypto.keyInfo()
    check('★ keyInfo 如实报不可用', info.available === false && info.ref === 'session:master', JSON.stringify(info))
    check('★ keyInfo 的错误也是人话', /读不出来/.test(info.error ?? ''), info.error)
    check(
      '★ 解不开的密文行：ok=false 且说了「解不开」',
      /解不开/.test(sessionCrypto.openLineDetailed(sealedSample).error),
    )
    credentialCore.get = realGet

    group('会话加密 / 配置白名单（不列进去就会被静默丢掉）')
    check('★ SECURITY_DEFAULTS 默认 false', secCfg.SECURITY_DEFAULTS.encryptSessions === false)
    check('★ normalizeSecurity 认得 true', secCfg.normalizeSecurity({ encryptSessions: true }).encryptSessions === true)
    check('★ 脏值不算开（只有 === true 才开）', secCfg.normalizeSecurity({ encryptSessions: 'yes' }).encryptSessions === false)
    check('规范化没把 network 段改坏', secCfg.normalizeSecurity({}).network.mode === 'ask')
    check(
      '★ 过一遍真 normalize() 也保得住（白名单没漏）',
      configNormalize.normalize({ security: { encryptSessions: true } }).security.encryptSessions === true,
    )
    const src = readFileSync(join(ROOT, 'electron/core/session-crypto.cjs'), 'utf8')
    /*
   * 断言的是「默认值指向真实数据目录，沙箱只是**注入**」这个**意图**，
   * 而不是某个具体写法（`?? DIRS.sessions` / `: DIRS.sessions` 都对，
   * 钉死其中一种只会让重构成红 —— 上面 32-notify 那组刚为同一件事返工过）。
   */
  check(
    '★ migrate 默认目录就是 data/sessions（沙箱只是注入）',
    /DIRS\.sessions/.test(src) && !/selftest-workspace/.test(src),
  )
    /* ⚠️ 别在断言里写完整的 backup 相对 require 字面量：selftest.mjs 会**扫文本**，把那串字
     当成「本文件 require 了不存在的文件」而误报（组 66 踩过）。拆一半既能钉住这件事，
     又不触发那条检查。 */
  const backupCall = "require('./backup" + ".cjs').create"
  check('★ migrate 默认真的调 backup.cjs 的 create（接线钉子）', src.includes(backupCall))

    group('会话加密 / 绝不碰用户真实数据')
    const after = snapshot()
    check('★ 真实 data/sessions 文件数没变', after.count === before.count, `${before.count} → ${after.count}`)
    check('★ 真实 data/sessions 总字节没变', after.bytes === before.bytes, `${before.bytes} → ${after.bytes}`)
  } finally {
    /* 还原：**这一步绝不能漏** —— 否则后面所有组都在用假凭证库 */
    credentialCore.get = realGet
    credentialCore.set = realSet
    configModule.get = realConfigGet
    sessionCrypto._resetKeyCache()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
}
