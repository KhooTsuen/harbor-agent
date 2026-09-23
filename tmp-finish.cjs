/* 临时脚本：清理 tmp-* 临时文件 + 提交推送 v1.15.0 + 打印状态 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = 'E:/CodexWorkbench'
const self = path.basename(__filename)
const git = (args, input) =>
  execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', input })

/* 1. 清理临时文件 */
let removed = 0
for (const name of fs.readdirSync(ROOT)) {
  if (!name.startsWith('tmp-')) continue
  if (name === self) continue
  try {
    const full = path.join(ROOT, name)
    if (fs.statSync(full).isDirectory()) continue
    fs.unlinkSync(full)
    removed += 1
  } catch {
    /* 占用中就算了 */
  }
}

/* 2. 提交并推送 */
git(['add', '-A'])

const message = [
  'v1.15.0：对话内容在磁盘上加密（逐行封印，默认关）',
  '',
  '以前只加密了 API Key，对话内容是明文（data/sessions/*.jsonl 文本编辑器就能看）。',
  '',
  '· 逐行封印 e1:<b64(iv|tag|ct)>（AES-256-GCM），不是整文件加密 ——',
  '  JSONL「追加即写 / 崩了只丢最后一行 / 能直接看」这三点一个都没丢。',
  '  某行解不开只跳过那一行；老明文行在开启状态下照样读得回。',
  '· 密钥走凭证库的 session:master（不进 config.json）。',
  '· **默认关，刻意如此**：开启会重写全部会话文件（大规模数据改动，硬约束 #5），',
  '  默认开等于用户升级一次就被静默重写全部聊天记录。',
  '  开启时先自动备份；备份失败即中止、一个字节都不动；幂等可重入；',
  '  拿不到密钥时**抛错而不是回落明文**（「以为加密了其实没加」是最糟的结果）。',
  '· 设置 →「权限与安全」面板数**真实文件**报「已加密 N 行 / 明文 M 行」，',
  '  配置说开着而盘上还有明文会显眼提示；并如实写明只防「文件被拷走」、',
  '  不防正在运行的程序。',
  '',
  '验证：typecheck 0 · lint 0 · 606 文件 0 超行 · 单测 667 · 内核自检 2409/0 ·',
  'build 通过；真机「权限与安全」命中加密面板 7 处文案',
  '',
  '顺带：修掉 3 条「钉死具体写法」的断言（preload 订阅、register-handlers 返回、',
  'migrate 默认目录）—— 它们把实现细节当成了需求，一次无害重构就变红',
].join('\n')

process.stdout.write(git(['commit', '-F', '-'], message))
process.stdout.write(git(['push', 'origin', 'main']))
process.stdout.write(`清理 ${removed} 个临时文件\n`)
process.stdout.write(git(['log', '--oneline', '-3', '--decorate']))
process.stdout.write(git(['status', '-sb']).split('\n')[0] + '\n')

fs.unlinkSync(path.join(ROOT, self))
