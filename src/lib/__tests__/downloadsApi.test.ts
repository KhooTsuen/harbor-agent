import { describe, expect, it } from 'vitest'
import { fileNameFromUrl, joinTarget } from '../downloadsApi'

/* 「保存到」拆成「文件名 + 文件夹」两个框之后，这两个纯函数是它的地基：
   文件名从地址里带出来（浏览器就是这么干的），最后拼成内核要的那条路径。
   2026-10-11 真机踩过：以前一个框要填完整路径，用户填 `E:\Download`（以为是文件夹），
   内核当文件名 → 建父目录 `E:\` → Windows 上 mkdir 抛 EPERM。拆成两个框 + 这两个函数
   之后，「只填文件夹」这条路从界面上就不存在了。 */

describe('从地址带出文件名（像浏览器那样）', () => {
  it('取路径末段', () => {
    expect(fileNameFromUrl('https://mirrors.tuna.tsinghua.edu.cn/debian-cd/x.iso')).toBe('x.iso')
  })

  it('剥掉查询串与片段（签名地址的 token 不该混进文件名）', () => {
    expect(fileNameFromUrl('https://a.com/f.zip?token=abc&x=1#frag')).toBe('f.zip')
  })

  it('百分号编码解开', () => {
    expect(fileNameFromUrl('https://a.com/%E4%B8%AD%E6%96%87.iso')).toBe('中文.iso')
  })

  it('路径末段猜不出（`/`、`/download?id=1`）→ 空串，让用户自己填', () => {
    expect(fileNameFromUrl('https://a.com/')).toBe('')
    expect(fileNameFromUrl('https://a.com')).toBe('')
    expect(fileNameFromUrl('https://a.com/download?id=1')).toBe('download')
  })

  it('不是合法地址 → 空串（不抛）', () => {
    expect(fileNameFromUrl('随便写的')).toBe('')
    expect(fileNameFromUrl('')).toBe('')
  })
})

describe('文件夹 + 文件名 → 一条路径', () => {
  it('文件夹留空 → 只给文件名，由内核按工作目录展开', () => {
    expect(joinTarget('', 'x.iso')).toBe('x.iso')
    expect(joinTarget('   ', 'x.iso')).toBe('x.iso')
  })

  it('文件夹末尾有几个斜杠都不重复', () => {
    expect(joinTarget('E:\\Download', 'x.iso')).toBe('E:\\Download\\x.iso')
    expect(joinTarget('E:\\Download\\', 'x.iso')).toBe('E:\\Download\\x.iso')
    expect(joinTarget('E:/Download/', 'x.iso')).toBe('E:/Download\\x.iso')
  })

  it('没有文件名 → 空串（「只填了文件夹」这条老路彻底消失）', () => {
    expect(joinTarget('E:\\Download', '')).toBe('')
    expect(joinTarget('', '')).toBe('')
  })
})
