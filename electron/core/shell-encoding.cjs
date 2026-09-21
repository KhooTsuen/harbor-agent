/**
 * Windows 命令输出的编码（实测踩出来的）
 *
 * 中文 Windows 上 `cmd.exe` **自己的**输出（`echo 中文`、`dir`）是 **GBK**，
 * 而 Node 的 `exec` 默认按 UTF-8 解码 —— 于是终端里看到的是
 * `中文输出测试` → `�����������`，中文文件名也糊成一团。
 *
 * ── 为什么不用 `chcp 65001` 解决 ──
 *
 * 试过，没用。`chcp` 改的是**控制台**的代码页，而 `exec` 的输出是**管道**：
 * 没有控制台时，cmd 的内建命令写管道仍然按系统 OEM 代码页编码。
 * （交互式终端那条路不一样 —— 那里真有控制台，`chcp` 是有效的，见 `pty.cjs`。）
 *
 * ── 所以规则是「先严格 UTF-8，不行再 OEM 代码页」──
 *
 *   · 纯 ASCII、`git` 的输出、`type` 读一个 UTF-8 文件 → 严格 UTF-8 解得开
 *   · cmd 内建命令的 GBK 字节 → 严格 UTF-8 会抛，落到系统 OEM 代码页
 *
 * 两个方向都覆盖，而且**不需要新依赖**：`TextDecoder` 认 gbk / big5 / shift_jis
 * 这些标签（Node 与 Electron 都带完整 ICU）。
 */

const { execSync } = require('node:child_process')

/** 代码页号 → TextDecoder 标签（认不出来的会退回 windows-1252） */
const LABELS = {
  936: 'gbk',
  950: 'big5',
  932: 'shift_jis',
  949: 'euc-kr',
  65001: 'utf-8',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  866: 'ibm866',
}

let cached = ''

/** 系统 OEM 代码页对应的解码标签（只探测一次） */
function oemLabel() {
  if (cached) return cached
  cached = process.platform === 'win32' ? 'windows-1252' : 'utf-8'
  if (process.platform !== 'win32') return cached

  try {
    /* `chcp` 自己的输出是纯 ASCII（"Active code page: 936"），怎么解都不会乱 */
    const out = String(execSync('chcp', { encoding: 'utf8', windowsHide: true, timeout: 5000 }))
    const num = Number((out.match(/(\d{3,5})/) ?? [])[1])
    if (LABELS[num]) cached = LABELS[num]
  } catch {
    /* 探测失败就用兜底 —— 这一层绝对不能把命令本身搞挂 */
  }
  return cached
}

/** 把命令的输出字节解成字符串（Buffer / 字符串都能收） */
function decode(chunk) {
  if (chunk == null) return ''
  if (typeof chunk === 'string') return chunk
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  if (bytes.length === 0) return ''

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder(oemLabel()).decode(bytes)
    } catch {
      return bytes.toString('utf8')
    }
  }
}

module.exports = { decode, oemLabel }
