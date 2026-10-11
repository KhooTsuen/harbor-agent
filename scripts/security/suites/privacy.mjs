/**
 * security:privacy —— 密钥 / 隐私 / 日志（SEC-067 ~ 076）
 *
 * 本轮实现首批里的：067（API Key 不出现在日志/导出，用哨兵扫）。
 */

import { sec, mark } from '../harness.mjs'
import { fs, path, require, ROOT, SENTINEL_KEY, SENTINEL_PAT } from '../sandbox.mjs'
import { CASES } from '../cases.mjs'

const join = path.join

/** 递归扫一个目录下所有文件，返回「含 needle 的文件」清单 */
function filesContaining(dir, needle) {
  const hits = []
  if (!fs.existsSync(dir)) return hits
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else {
        try {
          if (fs.readFileSync(p, 'utf8').includes(needle)) hits.push(p)
        } catch {
          /* 读不了就跳过 */
        }
      }
    }
  }
  walk(dir)
  return hits
}

/** SEC-067：哨兵假密钥不能出现在日志 / 记忆 / 导出的任何角落 */
function keyNeverLeaks(redact, memory, log) {
  /* ① 登记后精确替换 */
  redact.remember(SENTINEL_KEY, 'security-canary')
  const blob = `Authorization: Bearer ${SENTINEL_KEY} && token=${SENTINEL_PAT}`
  const out = redact.redact(blob)
  sec('SEC-067', !out.includes(SENTINEL_KEY), '登记过的密钥在文本里被替换')
  sec('SEC-067', !out.includes(SENTINEL_PAT), 'github_pat_ 前缀密钥被替换')

  /* ② 没见过也要靠模式认出来 */
  sec('SEC-067', redact.looksSecret(`sk-${'a'.repeat(48)}`) === true, 'sk- 前缀的长串被判为密钥')
  sec('SEC-067', redact.looksSecret(SENTINEL_PAT) === true, 'github_pat_ 被判为密钥')

  /* ③ 真写一条含密钥的日志，再扫日志目录 —— 匹配数必须是 0 */
  try {
    log.warn(`[security] 哨兵不该落盘：${SENTINEL_KEY}`)
  } catch {
    /* 记不上不影响扫 */
  }
  sec('SEC-067', redact.isSecretKey('apiKey') === true, '字段名 apiKey 被判为敏感键')

  /* ④ 含密钥的记忆被门禁拒绝 */
  const refused = memory.add({ content: `我的个人密钥是 ${SENTINEL_KEY}，请记住`, type: 'fact' })
  sec('SEC-067', refused.ok === false, '含密钥的记忆写入被拒')
}

export async function run() {
  const redact = require(join(ROOT, 'electron/core/redact.cjs'))
  const memory = require(join(ROOT, 'electron/core/memory.cjs'))
  const log = require(join(ROOT, 'electron/core/log.cjs'))
  console.log('\n· SEC-067 密钥不外泄')
  try {
    keyNeverLeaks(redact, memory, log)
  } catch (error) {
    sec('SEC-067', false, `套件抛错：${error instanceof Error ? error.message : error}`)
  }
  /* 全量扫描隔离数据目录：哨兵原值不该出现（日志确实落盘后才有意义） */
  const hits = filesContaining(path.join(ROOT, 'data', 'security-data'), SENTINEL_KEY)
  sec('SEC-067', hits.length === 0, `隔离数据目录里哨兵出现 0 次（实际 ${hits.length} 个文件${hits.length ? '：' + hits.join(', ') : ''}）`)

  for (const c of CASES.filter((c) => c.suite === 'privacy' && c.id !== 'SEC-067')) {
    mark(c.id, 'NOT_RUN', '待实现（下一批）')
  }
}
