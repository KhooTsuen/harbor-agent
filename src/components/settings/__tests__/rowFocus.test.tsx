import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Row } from '../parts'

/* ══════════════════════════════════════════════════════════════
   设置行：点标题有没有反应

   试玩反馈「设置有些地方点不开」—— 一类就是：标题看着能点，点上去却毫无反应。
   这里钉住两件事：
     · 同行是**文本类**控件 → 点标题把光标送进去
     · 同行是**勾选类** → 点标题什么都不做（顺手把开关拨了才是真坑），
       而且标题不该装成能点的样子（不给 cursor-text）
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const title = (text: string): HTMLElement =>
  [...container.querySelectorAll('p')].find((p) => p.textContent === text) as HTMLElement

describe('设置行 / 点标题', () => {
  it('★ 点标题把光标送进同行的输入框', () => {
    act(() => {
      root.render(
        <Row label="命令超时" hint="超时就不等了">
          <input defaultValue="60" />
        </Row>,
      )
    })
    const heading = title('命令超时')
    expect(heading.className).toContain('cursor-text')
    act(() => {
      heading.click()
    })
    expect(document.activeElement).toBe(container.querySelector('input'))
  })

  it('★ 下拉框也吃这一下', () => {
    act(() => {
      root.render(
        <Row label="回答深度">
          <select defaultValue="standard">
            <option value="standard">标准</option>
          </select>
        </Row>,
      )
    })
    act(() => {
      title('回答深度').click()
    })
    expect(document.activeElement).toBe(container.querySelector('select'))
  })

  it('★ 勾选类：点标题不碰它，也不装成能点', () => {
    act(() => {
      root.render(
        <Row label="联网">
          <label>
            <input type="checkbox" />
          </label>
        </Row>,
      )
    })
    const heading = title('联网')
    expect(heading.className).not.toContain('cursor-text')
    act(() => {
      heading.click()
    })
    const box = container.querySelector('input') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(document.activeElement).not.toBe(box)
  })
})
