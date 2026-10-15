/**
 * 读 PE 文件的**子系统**字段（实验 2 的核心判据：SEA 产物是 GUI 还是 CONSOLE）。
 *
 * 零依赖：PE 头结构固定 ——
 *   MZ 头 0x3C 处是 PE 头偏移；PE 头 +24 是可选头 magic；可选头 +68 是 Subsystem。
 */

const fs = require('node:fs')

const SUBSYSTEM = {
  0: 'UNKNOWN',
  1: 'NATIVE',
  2: 'WINDOWS_GUI',
  3: 'WINDOWS_CONSOLE',
  5: 'OS2_CONSOLE',
  7: 'POSIX_CONSOLE',
  9: 'WINDOWS_CE_GUI',
  10: 'EFI_APPLICATION',
  13: 'EFI_ROM',
}

/**
 * @param {string} file
 * @returns {{ file: string, format?: string, subsystem?: number, label?: string, error?: string }}
 */
function peSubsystem(file) {
  let b
  try {
    b = fs.readFileSync(file)
  } catch (error) {
    return { file, error: `读不到：${error instanceof Error ? error.message : error}` }
  }
  if (b.length < 0x40) return { file, error: '太小，不是 PE' }

  const peOff = b.readUInt32LE(0x3c)
  if (peOff + 24 + 70 > b.length) return { file, error: 'PE 偏移越界' }
  if (b.toString('ascii', peOff, peOff + 4) !== 'PE\u0000\u0000') return { file, error: '没有 PE 签名' }

  const magic = b.readUInt16LE(peOff + 24)
  const subsystem = b.readUInt16LE(peOff + 24 + 68)
  return {
    file,
    format: magic === 0x20b ? 'PE32+' : magic === 0x10b ? 'PE32' : `MAGIC(${magic})`,
    subsystem,
    label: SUBSYSTEM[subsystem] ?? `OTHER(${subsystem})`,
  }
}

module.exports = { peSubsystem, SUBSYSTEM }
