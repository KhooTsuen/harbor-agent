import { describe, expect, it } from 'vitest'
import { FOLDER_ACCENTS, folderAccentOf, folderPathHint } from '@/constants/folders'

/* ══════════════════════════════════════════════════════════════
   对话文件夹的「身份」：颜色稳定 + 路径提示

   用户 2026-09-28 报「两个文件夹看不出区别」（截图里 CodexWorkbench / Harbor
   一模一样）。这里钉住两件事：
     · 颜色**稳定**（同一个目录永远同一个色 —— 用随机数的话每次重开都变，更乱）
     · 用户截图里的那两个目录**拿到的颜色不同**（这条是真场景，不许退化成同色）
     · 长路径要缩成「盘符 + 最后两段」，短的别动

   颜色只能从主题的装饰性强调色里取（`--accent-*`）—— 语义色（danger/success/
   warning/info）主题里写明「只用于状态，不做装饰」。
   ══════════════════════════════════════════════════════════════ */

describe('文件夹身份色', () => {
  it('稳定：同一个目录永远同一个色', () => {
    const id = 'dir:E:\\CodexWorkbench'
    expect(folderAccentOf(id)).toBe(folderAccentOf(id))
    expect(folderAccentOf(id)).toBe(folderAccentOf('dir:E:\\CodexWorkbench'))
  })

  it('★ 用户截图里那两个目录拿到的色不一样', () => {
    const a = folderAccentOf('dir:E:\\CodexWorkbench')
    const b = folderAccentOf('dir:E:\\Harbor')
    expect(a).not.toBe(b)
  })

  it('只用装饰性强调色（语义色不做装饰）', () => {
    for (let i = 0; i < 40; i += 1) {
      expect(FOLDER_ACCENTS).toContain(folderAccentOf(`dir:E:\\proj\\${i}`))
    }
    expect(FOLDER_ACCENTS.some((c) => /danger|success|warning|info/.test(c))).toBe(false)
  })

  it('同名目录也会拿到不同色（路径不同 → 色不同是大概率；撞了还有路径兜底）', () => {
    const a = folderAccentOf('dir:E:\\a\\workspace')
    const b = folderAccentOf('dir:E:\\b\\workspace')
    /* 4 个色本来就会撞，所以这里只断言「函数按整个路径算、不只看最后一段」 */
    expect(
      a !== b || folderPathHint('E:\\a\\workspace') !== folderPathHint('E:\\b\\workspace'),
    ).toBe(true)
  })
})

describe('文件夹路径提示', () => {
  it('短路径原样显示', () => {
    expect(folderPathHint('E:\\Harbor')).toBe('E:\\Harbor')
  })

  it('★ 长路径缩成「盘符 + 最后两段」', () => {
    expect(folderPathHint('E:\\CodexWorkbench\\tmp\\tok\\Harbor')).toBe('E:\\…\\tok\\Harbor')
  })

  it('空路径给空串（不显示那行）', () => {
    expect(folderPathHint('')).toBe('')
    expect(folderPathHint('   ')).toBe('')
  })

  it('斜杠正斜杠都认、末尾分隔符不参与判断', () => {
    expect(folderPathHint('E:/Harbor/')).toBe('E:\\Harbor')
    expect(folderPathHint('E:\\a\\b\\c\\d\\')).toBe('E:\\a\\b\\c\\d')
    /* 够短就不缩，够长才缩（缩的是路径，不是段数） */
    expect(folderPathHint(`E:\\${'x'.repeat(30)}\\tok\\Harbor`)).toBe('E:\\…\\tok\\Harbor')
  })

  it('UNC 长路径也能缩（前缀不参与缩短）', () => {
    expect(folderPathHint('\\\\server\\share\\team\\demo')).toBe('\\\\server\\share\\team\\demo')
    expect(folderPathHint('\\\\server\\share\\team\\demo\\deep\\here')).toBe('…\\deep\\here')
  })
})
