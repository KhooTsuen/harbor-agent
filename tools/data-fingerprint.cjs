/**
 * data/ 指纹：文件数 / 总字节 / 最新 mtime
 *
 * 用法：node tools/data-fingerprint.cjs <目录>
 *
 * 为什么单独一个脚本、而不是在 .bat 里内联 PowerShell：
 *   `.bat` 里 `for /f` 的反引号命令中，`|`、`>`、`=>` 都要转义 ——
 *   写成一行极容易静默失败（实测匿名函数里的 `=>` 会被 cmd 当成重定向）。
 *   放成文件就用不上任何转义。
 *
 * 更新装机版前后各跑一次，两行必须**逐字相同** —— 不同就说明 data/ 被动过。
 */
const fs = require('node:fs')

const dir = process.argv[2]
if (!dir) {
  console.log('用法：node tools/data-fingerprint.cjs <目录>')
  process.exit(2)
}

let files = 0
let bytes = 0
let newest = 0

const walk = (current) => {
  let entries = []
  try {
    entries = fs.readdirSync(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = `${current}\\${entry.name}`
    if (entry.isDirectory()) {
      walk(full)
    } else if (entry.isFile()) {
      try {
        const st = fs.statSync(full)
        files += 1
        bytes += st.size
        newest = Math.max(newest, st.mtimeMs)
      } catch {
        /* 读不到的跳过（正在被写、已删除） */
      }
    }
  }
}

if (!fs.existsSync(dir)) {
  console.log(`(目录不存在：${dir})`)
  process.exit(1)
}

walk(dir)
console.log(`文件 ${files} 个 / ${bytes} 字节 / 最新 ${new Date(newest).toISOString()}`)
