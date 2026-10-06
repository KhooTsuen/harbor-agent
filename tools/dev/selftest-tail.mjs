/*
 * 只打内核自检的结尾几行 —— 完整输出 29KB，工具那边会被截断，
 * 而我们只关心最后那两行统计（「N 项通过 / M 失败」）。
 * 从 stdin 读不好办，就直接自己跑一遍再把尾巴打出来。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const out = execFileSync(process.execPath, ['scripts/selftest.mjs'], {
  encoding: 'utf8',
  maxBuffer: 1e9,
})
const lines = out.split(/\r?\n/)
/* 把失败行也挑出来：有失败时结尾的统计之外还要能直接看到是哪几条 */
const failLines = lines.filter((l) => l.includes('❌') || l.includes('FAIL'))
const tail = [...failLines, '────── 结尾 ──────', ...lines.slice(-12)].join('\n')
writeFileSync('tmp/selftest-tail.txt', tail, 'utf8')
console.log(tail)
