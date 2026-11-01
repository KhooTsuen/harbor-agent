/**
 * M02-B：**当前网页卡**（对话区上方，展示「侧边栏现在看着哪个页面」+ 上下文开关）
 *
 * ── 三个必须讲清的点 ───────────────────────────────────────────
 *
 * ① **数据是扩展自己取的**，不经主进程。`chrome.tabs.query({active,currentWindow})`
 *    本来就在扩展手里 —— 为此多一次 IPC 往返没有意义（设计文档 §0「先问数据从哪来」）。
 *
 * ② **「能不能读」用 `url` 是否为空当判据**，与 M03/`active-tab.js` **同一口径**。
 *    产品 manifest **刻意没有 `tabs` 权限**（M07 最小权限），所以 url 只有在
 *    `activeTab` 授予后才看得见。**看不到 url = 读不了**，这不是「我们没实现」，
 *    而是浏览器权限模型的直接结果。
 *    ⚠️ 别提示「去设置里开权限」—— 用户能做的只有「点一下扩展图标」。
 *
 * ③ **上下文开关只存本地**（`chrome.storage.local`），**不进 Harbor**。
 *    它决定「读当前页 / 观察页面」是否默认带上这个页面。
 *
 * 判据本身在 `page-info.ts`（纯函数，自检能直接跑）—— 本文件只负责
 * 「订阅标签变化 + 画出来」，两处各写一份判据必然漂。
 */

/* global chrome */

import { useEffect, useState } from 'react'
import { Globe } from 'lucide-react'
import { CTX_KEY, canRead, ctxEnabledFrom, hostLabel, titleLabel, type PageInfo } from './page-info'
import { hasAccessTo, originPatternOf, requestSite } from './site-access'

/**
 * 读一次当前活动标签。
 *
 * 失败一律返回 `url:''`（= 读不了），**不抛** —— 卡片是展示件，不该把面板弄挂。
 */
async function readActive(): Promise<PageInfo | null> {
  try {
    const list = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = list && list[0]
    if (!tab) return null
    return { title: String(tab.title ?? ''), url: String(tab.url ?? '') }
  } catch {
    return null
  }
}

async function readCtxEnabled(): Promise<boolean> {
  try {
    return ctxEnabledFrom(await chrome.storage.local.get(CTX_KEY))
  } catch {
    return false
  }
}

/**
 * @param {{ onStatus?: (s: { text: string; tone: 'info' | 'danger' } | null) => void }} props
 */
export function PageCard({ onStatus }: { onStatus?: (s: { text: string; tone: 'info' | 'danger' } | null) => void }) {
  const [info, setInfo] = useState<PageInfo | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [mounted, setMounted] = useState(false)
  /* 这个站点是否已被「按站点记住」/「整站读取」覆盖（null = 还没查出来） */
  const [remembered, setRemembered] = useState<boolean | null>(null)

  /* 挂载后先读一次，然后跟着标签切换刷新（用户切页面，卡片要跟着变） */
  useEffect(() => {
    setMounted(true)
    void readActive().then(setInfo)
    void readCtxEnabled().then(setEnabled)
    const onActivated = () => void readActive().then(setInfo)
    const onUpdated = (_id: number, change: { url?: string; status?: string }) => {
      if (change.url || change.status === 'complete') void readActive().then(setInfo)
    }
    const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && CTX_KEY in changes) setEnabled(changes[CTX_KEY]?.newValue !== false)
    }
    try {
      chrome.tabs.onActivated.addListener(onActivated)
      chrome.tabs.onUpdated.addListener(onUpdated)
      chrome.storage.onChanged.addListener(onStorage)
    } catch {
      /* 监听不上就只在挂载时读一次 —— 不因此让面板报错 */
    }
    return () => {
      try {
        chrome.tabs.onActivated.removeListener(onActivated)
        chrome.tabs.onUpdated.removeListener(onUpdated)
        chrome.storage.onChanged.removeListener(onStorage)
      } catch {
        /* 已经没了 */
      }
    }
  }, [])

  /* 拿到 url 之后查一次：这个站点是否已被浏览器允许（整站 或 按站点记住） */
  useEffect(() => {
    const url = String(info?.url ?? '')
    if (!url) {
      setRemembered(null)
      return
    }
    let alive = true
    void hasAccessTo(url).then((value) => {
      if (alive) setRemembered(value)
    })
    return () => {
      alive = false
    }
  }, [info?.url])

  const toggle = async (next: boolean) => {
    if (saving) return
    setSaving(true)
    try {
      await chrome.storage.local.set({ [CTX_KEY]: next })
    } catch {
      onStatus?.({ text: '设置没有保存成功；网页上下文状态未改变，请重试', tone: 'danger' })
      setSaving(false)
      return
    }
    setEnabled(next)
    setSaving(false)
    onStatus?.({
      text: next ? '已开启：读当前页 / 观察页面会带上这个页面' : '已关闭：读当前页 / 观察页面不会自动带上',
      tone: 'info',
    })
  }

  /*
   * 「记住本页」—— 只把这个域名加进授权，以后不用再点图标。
   *
   * ★ 第一句 await 必须是 `requestSite`：`chrome.permissions.request` 要求
   *   在用户手势的调用栈里被调起，前面插一个 await 就会丢手势、申请直接失败。
   *   所以这里用 `.then` 而不是 `await`，让 requestSite 在点击那一刻同步发起。
   * ★ 拿不到 url 时（没点过图标）不显示这个按钮 —— 申请 origin 需要具体地址。
   */
  const remember = () => {
    const url = String(info?.url ?? '')
    if (!url || saving) return
    setSaving(true)
    void requestSite(url).then((ok) => {
      setSaving(false)
      setRemembered(ok ? true : null)
      onStatus?.({
        text: ok
          ? `已记住 ${originPatternOf(url)}：以后在这个站点不用再点图标`
          : '没有记住（你在授权框里点了取消）—— 仍然可以在每个页面点一次图标来读',
        tone: ok ? 'info' : 'danger',
      })
    })
  }

  /* 挂载前不显示（非扩展环境下 chrome.* 不存在） */
  if (!mounted) return null

  const readable = canRead(info)
  /*
   * ★ 为什么不再同时渲染 `titleLabel` 和 `hostLabel`（2026-10-21 修）：
   *   `titleLabel` 在标题为空时**退回 `hostLabel`**（page-info.ts:48），而 `hostLabel`
   *   在拿不到 url 时返回「读不到地址」—— 两个 span 于是把同一句渲染了两遍，
   *   用户看到「读不到地址 读不到地址 点图标才能读」，像坏了。
   *   现在按「能读 / 读不了」分成两支，每支只出一句。
   */
  const pageTitle = String(info?.title ?? '').trim()
  const host = readable ? hostLabel(info) : ''
  /* 标题与域名相同就不重复显示第二行 */
  const subTitle = pageTitle && pageTitle !== host ? pageTitle : ''

  return (
    <div
      aria-label="当前网页卡"
      className="mx-2 mb-1 flex shrink-0 items-center gap-2 rounded-base border border-line-hairline bg-bg-raised px-2.5 py-1.5 text-2xs"
    >
      <Globe size={13} aria-hidden="true" className="shrink-0 text-fg-tertiary" />
      {readable ? (
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 主行：域名（用户认站点最快）。副行：页面标题，没有就整行不出现 */}
          <span aria-label="当前网页域名" title={String(info?.url ?? '')} className="truncate text-dense leading-tight text-fg-primary">
            {host}
          </span>
          {subTitle ? (
            /* `titleLabel` 保留：它是「人读标签」的唯一出处，这里只取它的值 */
            <span aria-label="当前网页标题" className="truncate text-2xs text-fg-tertiary">
              {titleLabel(info)}
            </span>
          ) : null}
        </div>
      ) : (
        /*
         * 读不了：一句话说清，**不提「点图标」**。
         * 受浏览器保护的页面（edge://extensions、扩展商店等）点图标也读不到，
         * 原来那句「点图标才能读」会让人白试一次（用户 2026-10-21 拍板改成中性陈述）。
         */
        <span aria-label="读不了原因" className="min-w-0 flex-1 truncate text-fg-tertiary" title="这个页面不提供地址，读不到它的内容">
          这个页面读不了
        </span>
      )}
      {readable && remembered === false ? (
        <button
          type="button"
          aria-label="记住本页"
          title="把这个域名加进授权：以后在这个站点不用再点图标（会弹一次 Edge 授权框）"
          disabled={saving}
          onClick={remember}
          className="shrink-0 rounded-sm px-1.5 py-0.5 text-2xs text-fg-tertiary underline decoration-line-hairline underline-offset-2 transition-colors hover:bg-bg-hover hover:text-fg-primary disabled:opacity-50"
        >
          记住本页
        </button>
      ) : null}
      {/* 上下文开关：右侧常驻，是这张卡上唯一「改变行为」的控件，所以用 label 包住整块 */}
      <label
        className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-2xs text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-secondary"
        title="关掉后不会自动带上这个页面"
      >
        <input
          type="checkbox"
          aria-label="上下文开关"
          checked={enabled}
          disabled={saving}
          onChange={(e) => toggle(e.target.checked)}
          className="h-3 w-3 accent-current"
        />
        带上
      </label>
    </div>
  )
}
