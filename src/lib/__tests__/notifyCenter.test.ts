import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFY_ROUTES,
  NOTIFY_CATEGORIES,
  categoryOf,
  normalizeRoutes,
  routeFor,
} from '@/lib/notifyCenter'
import { useUIStore } from '@/stores/useUIStore'
import { unreadNotifyCount, useNotifyCenter } from '@/stores/useNotifyCenter'
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/useSettingsStore'

/* ══════════════════════════════════════════════════════════════
   通知中心：右下角只留「要你处理的事」，其余进右栏「通知」标签

   这一组钉的是**分流这件事本身**，不是某个按钮的样子：

     ① 分类规则可预测（同样的一句话永远进同一处）
     ② 三档互斥（弹卡片 / 只进这里 / 都不要），且默认就是「右下角只留要紧的」
     ③ 进了收件箱的**不再进**右下角那份历史（否则同一件事两处出现，像发生了两次）
     ④ 老配置缺字段时逐类补默认，不把用户改过的类一起冲掉
   ══════════════════════════════════════════════════════════════ */

const items = () => useNotifyCenter.getState().items
const toasts = () => useUIStore.getState().toasts

/** 把某一类改成指定去向（模拟用户在面板顶上点的那个按钮） */
function setRoute(category: keyof typeof DEFAULT_NOTIFY_ROUTES, route: 'toast' | 'center' | 'off') {
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, notifyRoutes: { ...s.settings.notifyRoutes, [category]: route } },
  }))
}

beforeEach(() => {
  useUIStore.setState({ toasts: [], toastHistory: [] })
  useNotifyCenter.setState({ items: [] })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
})

describe('① 分类规则', () => {
  it('error → 出错；warning → 过程播报；info 带按钮 → 要你拍板；纯 info → 日常确认', () => {
    expect(categoryOf('error', false)).toBe('error')
    expect(categoryOf('error', true)).toBe('error')
    expect(categoryOf('warning', false)).toBe('agent')
    expect(categoryOf('info', true)).toBe('needYou')
    expect(categoryOf('info', false)).toBe('info')
    expect(categoryOf('success', false)).toBe('info')
  })

  it('★ 调用方点名的类别优先（比按 kind 猜准）', () => {
    /* 「下载完成」是 success，但它是 download 类，不属于日常确认 */
    expect(categoryOf('success', true, 'download')).toBe('download')
    expect(categoryOf('success', true, 'task')).toBe('task')
  })

  it('每一类都有展示文案（面板上的设置项读它，不许有漏的）', () => {
    expect(NOTIFY_CATEGORIES).toHaveLength(6)
    for (const cat of NOTIFY_CATEGORIES) {
      expect(cat.label.length).toBeGreaterThan(0)
      expect(cat.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('② 默认去向：右下角只留要你处理的事', () => {
  it('★ 出错 / 要拍板 / 日常确认弹卡片；任务结果 / 下载 / 过程播报只进收件箱', () => {
    expect(DEFAULT_NOTIFY_ROUTES).toEqual({
      error: 'toast',
      needYou: 'toast',
      task: 'center',
      download: 'center',
      agent: 'center',
      info: 'toast',
    })
  })

  it('★ 一条「任务跑完了」进收件箱，不弹右下角', () => {
    /* 用户在看别处的时候，任务完成不该打断他 —— 这正是「碍眼」的源头 */
    const id = useUIStore
      .getState()
      .showToast('success', '跑完了', '改了 3 个文件', undefined, 'task')
    expect(id).toBe('')
    expect(toasts()).toHaveLength(0)
    expect(items()).toHaveLength(1)
    expect(items()[0].title).toBe('跑完了')
    expect(items()[0].unread).toBe(true)
    /* 也不进右下角那份历史 —— 它已经在收件箱里了 */
    expect(useUIStore.getState().toastHistory).toHaveLength(0)
  })

  it('★ 一条错误照旧弹卡片（要你立刻知道的不能被收起来）', () => {
    const id = useUIStore.getState().showToast('error', '发送失败', '网络断了')
    expect(id).not.toBe('')
    expect(toasts()).toHaveLength(1)
    expect(items()).toHaveLength(0)
  })

  it('★ 用户改成「都不要」→ 既不弹也不记', () => {
    setRoute('info', 'off')
    const id = useUIStore.getState().showToast('success', '已保存')
    expect(id).toBe('')
    expect(toasts()).toHaveLength(0)
    expect(items()).toHaveLength(0)
  })

  it('★ 用户改成「弹卡片」→ 那一类回到右下角', () => {
    setRoute('task', 'toast')
    const id = useUIStore
      .getState()
      .showToast('success', '跑完了', '改了 3 个文件', undefined, 'task')
    expect(id).not.toBe('')
    expect(toasts()).toHaveLength(1)
    expect(items()).toHaveLength(0)
  })

  it('收件箱里那条带按钮时，按钮还能点（跳转逻辑原样保留）', () => {
    let clicked = 0
    useUIStore.getState().showToast(
      'info',
      '下载完成',
      'a.zip',
      {
        label: '查看',
        onClick: () => {
          clicked++
        },
      },
      'download',
    )
    const action = items()[0].action
    expect(action?.label).toBe('查看')
    action?.run()
    expect(clicked).toBe(1)
  })
})

describe('③ 收件箱自身', () => {
  it('★ 同一条未读重复进来只留一条（连续同样失败不刷屏）', () => {
    const push = useNotifyCenter.getState().push
    push({ category: 'agent', kind: 'warning', title: '正在重试' })
    push({ category: 'agent', kind: 'warning', title: '正在重试' })
    expect(items()).toHaveLength(1)
  })

  it('★ 已读之后同样的通知再进来算新的一条（那是新发生的事）', () => {
    const push = useNotifyCenter.getState().push
    push({ category: 'agent', kind: 'warning', title: '正在重试' })
    useNotifyCenter.getState().markAllRead()
    push({ category: 'agent', kind: 'warning', title: '正在重试' })
    expect(items()).toHaveLength(2)
  })

  it('★ 点开标签 = 全部已读，但**不清空**（看过 ≠ 处理过）', () => {
    useNotifyCenter.getState().push({ category: 'task', kind: 'success', title: '跑完了' })
    expect(unreadNotifyCount(items())).toBe(1)
    useNotifyCenter.getState().markAllRead()
    expect(unreadNotifyCount(items())).toBe(0)
    expect(items()).toHaveLength(1)
  })

  it('★ 收件箱有上限，超出丢最旧的（里面没东西时开关面板才不卡）', () => {
    const push = useNotifyCenter.getState().push
    for (let i = 0; i < 210; i++) {
      push({ category: 'task', kind: 'success', title: `第 ${i} 条` })
    }
    expect(items()).toHaveLength(200)
    /* 最新的在最前 */
    expect(items()[0].title).toBe('第 209 条')
  })

  it('清空只清收件箱，不影响右下角正在显示的那张卡', () => {
    useUIStore.getState().showToast('error', '失败了')
    useNotifyCenter.getState().push({ category: 'task', kind: 'success', title: '跑完了' })
    useNotifyCenter.getState().clear()
    expect(items()).toHaveLength(0)
    expect(toasts()).toHaveLength(1)
  })
})

describe('④ 老配置归一化', () => {
  it('★ 缺字段（老版本升上来）→ 每一类都补上默认，一个不缺', () => {
    expect(normalizeRoutes(undefined)).toEqual(DEFAULT_NOTIFY_ROUTES)
    expect(normalizeRoutes({})).toEqual(DEFAULT_NOTIFY_ROUTES)
  })

  it('★ 只改过一类时，其余五类必须留住默认（不能整表替换）', () => {
    const partial = normalizeRoutes({ download: 'toast' })
    expect(partial.download).toBe('toast')
    expect(partial.error).toBe(DEFAULT_NOTIFY_ROUTES.error)
    expect(partial.task).toBe(DEFAULT_NOTIFY_ROUTES.task)
  })

  it('认不出的值退默认（不把脏数据带进界面）', () => {
    const dirty = normalizeRoutes({ error: 'nope', task: null, agent: 42 })
    expect(dirty.error).toBe(DEFAULT_NOTIFY_ROUTES.error)
    expect(dirty.task).toBe(DEFAULT_NOTIFY_ROUTES.task)
    expect(dirty.agent).toBe(DEFAULT_NOTIFY_ROUTES.agent)
  })

  it('routeFor 拿不到表时退默认（测试夹具只给一部分也能跑）', () => {
    expect(routeFor(undefined, 'task')).toBe(DEFAULT_NOTIFY_ROUTES.task)
    const dirty = { error: 'nope' } as never
    expect(routeFor(dirty, 'error')).toBe(DEFAULT_NOTIFY_ROUTES.error)
  })
})

describe('⑤ 形状对齐：设置里那一份就是唯一真相源', () => {
  it('★ 默认设置里的 notifyRoutes 与 DEFAULT_NOTIFY_ROUTES 逐项一致', () => {
    /* 两边各写一份就会漂 —— 这条钉住「改了一处必须改另一处」 */
    expect(DEFAULT_SETTINGS.notifyRoutes).toEqual(DEFAULT_NOTIFY_ROUTES)
  })

  it('★ 用户改设置后，下一条提示立刻按新规则走（不缓存旧值）', () => {
    useUIStore.getState().showToast('success', '第一次', '进收件箱', undefined, 'task')
    expect(items()).toHaveLength(1)
    setRoute('task', 'toast')
    useUIStore.getState().showToast('success', '第二次', '这次弹', undefined, 'task')
    expect(toasts()).toHaveLength(1)
  })
})
