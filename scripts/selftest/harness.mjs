/**
 * 自检：记分与输出
 *
 * 从 scripts/selftest.mjs 拆出来的（那边 1193 行了）。
 * 只有三件事：记一笔成功/失败、打印组标题、最后汇总。
 *
 * 为什么单独一个文件：36 个测试组的模块都要用它，放在入口文件里会形成
 * 一堆循环 import（入口 import 组、组 import 入口）。
 */

let passed = 0
let failed = 0
const failures = []

export function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

export function group(title) {
  console.log(`\n── ${title} ──`)
}

/** 打印汇总，返回进程退出码（0 = 全过） */
export function report() {
  console.log(`\n════════════════════════════════`)
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`)
  if (failures.length > 0) {
    console.log('\n  失败清单：')
    for (const f of failures) console.log(`    · ${f}`)
  }
  console.log('════════════════════════════════\n')
  return failed > 0 ? 1 : 0
}
