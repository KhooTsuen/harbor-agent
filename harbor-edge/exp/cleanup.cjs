/**
 * 三组实验收尾清理：删光一切探针残留，一份不留。
 *
 * 保留（要进版本库的）：exp/ 下的 .cjs 实验脚本 + ext/ + lib/ + host*.cmd + sea 源码。
 * 删除（跑完即弃）：profiles/ manifests/ sea 产物 dist-portable 里那个 .cmd 注册表键。
 */
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const rm = (p) => {
  const exists = fs.existsSync(p)
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch (e) {
    console.log(`  ✗ 删不掉 ${p}：${e.message}`)
    return
  }
  console.log(`  ${exists ? '已删' : '本就不存在'}  ${p}`)
}

console.log('── 目录 ──')
rm('E:\\CodexWorkbench\\harbor-edge\\exp\\profiles')
rm('E:\\CodexWorkbench\\harbor-edge\\exp\\manifests')

console.log('── SEA 产物（源码保留）──')
for (const f of ['host-sea.exe', 'sea-prep.blob', 'chromium.log']) {
  rm(`E:\\CodexWorkbench\\harbor-edge\\exp\\sea\\${f}`)
}

console.log('── 构建产物里的实验 .cmd ──')
rm('E:\\CodexWorkbench\\dist-portable\\Harbor\\harbor-host.cmd')

console.log('── 注册表键 ──')
for (const name of ['com.harbor.exp1', 'com.harbor.exp2', 'com.harbor.exp3', 'com.harbor.phase0.probe']) {
  spawnSync('reg', ['DELETE', `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${name}`, '/f', '/reg:64'], {
    encoding: 'utf8',
  })
  spawnSync('reg', ['DELETE', `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${name}`, '/f', '/reg:32'], {
    encoding: 'utf8',
  })
}
console.log('  已发删除（下面复核）')

console.log('\n── 复核：Edge NativeMessagingHosts 下还有什么 ──')
const r = spawnSync('reg', ['QUERY', 'HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts'], { encoding: 'utf8' })
console.log(r.stdout?.trim() || '  （空 = 无任何键，干净）')

console.log('\n── 复核：harbor-edge/exp 下还剩什么 ──')
const walk = (dir, depth = 0) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    console.log(`${'  '.repeat(depth + 1)}${e.name}${e.isDirectory() ? '/' : ''}`)
    if (e.isDirectory() && depth < 2) walk(`${dir}\\${e.name}`, depth + 1)
  }
}
walk('E:\\CodexWorkbench\\harbor-edge\\exp')
