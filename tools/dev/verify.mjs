/*
 * 一次性验证脚本（不提交）：
 *   ① 把**本次改动过的** src/**\/*.ts(x) 过一遍 prettier --write（check:format 只认格式化过的）
 *   ② 跑 npm run verify（typecheck → lint → lint:kernel → format → lines → rules →
 *      test:rules → test:unit → 内核自检 → build）
 *   ③ 把结论写进 tmp/verify.txt —— 终端这条路今天一直在捣乱（吞输出、吃引号），
 *      写文件再读文件最稳。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'

function run(cmd, args, { shell = false } = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 1e9,
      shell,
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/* ① 改动过的源文件列表（含未跟踪） */
const changed = run('git', ['diff', '--name-only', 'HEAD'])
  .out.split(/\r?\n/)
  .concat(
    run('git', ['ls-files', '--others', '--exclude-standard'])
      .out.split(/\r?\n/),
  )
  .map((f) => f.trim())
  .filter((f) => f && /^src\/.*\.(ts|tsx)$/.test(f))

const prettier = 'node_modules/prettier/bin/prettier.cjs'
const fmt = existsSync(prettier)
  ? run(process.execPath, [prettier, '--write', ...changed])
  : { code: -1, out: `找不到 ${prettier}` }

/* ② 全链 */
const verify = run('npm.cmd', ['run', 'verify'], { shell: true })

/* ③ 报告 */
const lines = verify.out.split(/\r?\n/)
const bad = lines.filter((l) => /error TS|error |✖|❌|failed|FAIL|not ok|失败/i.test(l))
const report = [
  `prettier：${fmt.code === 0 ? '已格式化 ' + changed.length + ' 个文件' : '⚠️ 失败/跳过'}  ${changed.join(' ')}`,
  `verify：exit=${verify.code}`,
  '──── 异常行（最多 40）────',
  ...bad.slice(0, 40),
  '──── 结尾 18 行 ────',
  ...lines.slice(-18),
].join('\n')

writeFileSync('tmp/verify.txt', report, 'utf8')
/* 完整输出也留一份 —— 只在结尾看是会漏的（上一轮就是靠它才发现真正的失败步骤） */
writeFileSync('tmp/verify-full.txt', verify.out, 'utf8')
console.log(report)
