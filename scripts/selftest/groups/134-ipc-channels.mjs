import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync, readdirSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   IPC 通道清单：跟源码比对，漂了就报红

   `electron/ipc-channels.cjs` 是一份**手写的通道清单**，自检挨个点名
   （`channelsMissing`）。可手写的就会漂 —— 2026-10-09 查出来它真漂了：
   源码里注册了 152 个通道，清单漏登记 `log:action` / `log:error` 两个
   （`ipcMain.on` 注册的），还重复写了 `projectRules:reload` / `projectRules:status`。
   漏登记 = 那个通道从没被自检点名，兜底网的洞没人知道。

   所以加这一组：**扫源码**（`electron/` 下所有 `.cjs` 里 `ipcMain` 注册通道的
   那句字面量，handle / on 两类都算），跟清单比，两个方向都不许差。

   注意：这里只比**清单完不完整**。「运行时有没有真注册上」在应用自检里查
   （selftest-report.cjs 的 channelsMissing）—— 两者一起才盖得住。
   ══════════════════════════════════════════════════════════════ */

const { EXPECTED_CHANNELS } = require(join(ROOT, 'electron/ipc-channels.cjs'))

/** 扫一份源码文本，抠出注册通道那句的第一参数字面量（去掉注释再扫） */
function channelsInText(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const found = []
  for (const raw of noBlock.split(/\r?\n/)) {
    const code = raw.replace(/\/\/.*$/, '')
    for (const m of code.matchAll(/ipcMain\.(handle|on)\(\s*(['"])([^'"]+)\2/g)) found.push(m[3])
  }
  return found
}

function listCjs(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listCjs(full, acc)
    else if (entry.name.endsWith('.cjs')) acc.push(full)
  }
  return acc
}

export async function run() {
  group('IPC 通道清单：跟源码比对（漂了就报红）')

  const src = new Set()
  for (const file of listCjs(join(ROOT, 'electron'))) {
    for (const channel of channelsInText(readFileSync(file, 'utf8'))) src.add(channel)
  }
  const spec = new Set(EXPECTED_CHANNELS)

  check(`源码里扫到 ${src.size} 个通道`, src.size > 0)
  check('清单里去重了（没有重复通道）', spec.size === EXPECTED_CHANNELS.length)

  const inSrcNotSpec = [...src].filter((c) => !spec.has(c))
  const inSpecNotSrc = [...spec].filter((c) => !src.has(c))
  check(
    '★ 源码注册的通道，清单里都有（漏登记 = 从没被自检点名）',
    inSrcNotSpec.length === 0,
    `清单漏登记：${inSrcNotSpec.join(', ')}`,
  )
  check(
    '★ 清单里的通道，源码里都有（幽灵条目 = 清单在说谎）',
    inSpecNotSrc.length === 0,
    `清单多出来：${inSpecNotSrc.join(', ')}`,
  )

  check('含 .on 注册的 log:action / log:error（原来就漏了这俩）', spec.has('log:action') && spec.has('log:error'))
}
