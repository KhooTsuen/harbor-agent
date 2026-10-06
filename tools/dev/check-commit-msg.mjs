/* tmp/ 下的临时探针：真跑一遍 commit-msg 钩子（不合规的必须被拦） */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')
const hook = path.join(root, 'scripts', 'hooks', 'commit-msg.mjs')

const cases = [
  { name: '合规矩（修：）', subject: '修：输入框拖拽的三个问题', want: 0 },
  { name: '合规矩（文档：）', subject: '文档：把规矩写清楚', want: 0 },
  { name: '没前缀', subject: 'update stuff', want: 1 },
  { name: '半角冒号', subject: '修: 半角冒号', want: 1 },
  { name: '自己发明的词表', subject: '优化：随便编一个', want: 1 },
  { name: 'git 自己造的（Merge）', subject: "Merge branch 'x' into y", want: 0 },
  { name: 'git 自己造的（fixup!）', subject: 'fixup! 修：xxx', want: 0 },
]

let bad = 0
for (const c of cases) {
  const file = path.join(root, 'tmp', `cm-${Math.random().toString(36).slice(2)}.txt`)
  fs.writeFileSync(file, `${c.subject}\n\n正文\n# 注释\n`, 'utf8')
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [hook, file], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    code = error.status
    out = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  const ok = code === c.want
  if (!ok) bad += 1
  console.log(`${ok ? '✓' : '✗'} ${c.name}：退出码 ${code}（要 ${c.want}）`)
  const shown = out.split('\n').filter(Boolean).slice(0, 14)
  if (shown.length) console.log(shown.map((l) => `      ${l}`).join('\n'))
  fs.rmSync(file, { force: true })
}

/* 只有注释 / 空标题也得拦 */
const empty = path.join(root, 'tmp', 'cm-empty.txt')
fs.writeFileSync(empty, '# 只有注释\n', 'utf8')
try {
  execFileSync(process.execPath, [hook, empty], { cwd: root, stdio: 'pipe' })
  console.log('✗ 空标题应当被拦下，却放行了')
  bad += 1
} catch (error) {
  console.log(`✓ 空标题被拦下（退出码 ${error.status}）`)
}
fs.rmSync(empty, { force: true })

/* 读不到文件时不许把人堵死（这是钩子最容易咬人的地方） */
try {
  execFileSync(process.execPath, [hook, path.join(root, 'tmp', '根本不存在.txt')], {
    cwd: root,
    stdio: 'pipe',
  })
  console.log('✓ 读不到文件时放行（不把人堵死）')
} catch (error) {
  console.log(`✗ 读不到文件时应当放行，却退出了 ${error.status}`)
  bad += 1
}

console.log(bad === 0 ? '\n全部符合预期' : `\n${bad} 条不符合预期`)
process.exit(bad === 0 ? 0 : 1)
