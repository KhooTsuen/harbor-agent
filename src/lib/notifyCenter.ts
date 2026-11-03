import type { NotifyCategory, NotifyRoute, NotifyRoutes, ToastKind } from '@/types'

/* ══════════════════════════════════════════════════════════════
   通知的去向：分类 + 归一化（**纯函数，不碰 store、不碰 DOM**）

   ── 为什么需要这一层 ────────────────────────────────────────
   右下角那块以前混装三类性质完全不同的东西：
     ① 要你现在处理（出错 / 要拍板）
     ② 事后看就行（任务跑完 / 下载完成）
     ③ 过程播报（正在重试 / 换了供应商 / 在动网页）
   ②③ 把 ① 挤没了 —— 这才是「碍眼」的根因，不是卡片太大或太快。

   所以做法不是把所有提示调小，而是**给 ②③ 一个收件箱**（右栏「通知」标签），
   让 ① 独占右下角。每类去哪儿由用户自己定（`Settings.notifyRoutes`）。

   ── 为什么分类要单独成函数 ──────────────────────────────────
   分流（`useUIStore.showToast`）和面板上的设置项读**同一份**分类 ——
   两边各写一套的话，用户改了设置却发现某条提示还是照弹，这种账本项目
   已经付过（见 AGENT.md 第 9 条）。
   ══════════════════════════════════════════════════════════════ */

/** 面板上那一列设置项的**唯一清单**（顺序即展示顺序） */
export const NOTIFY_CATEGORIES: readonly {
  id: NotifyCategory
  label: string
  hint: string
}[] = [
  {
    id: 'error',
    label: '出错',
    hint: '请求失败、工具报错、没保存上',
  },
  {
    id: 'needYou',
    label: '要你处理',
    hint: '权限确认、澄清提问、敏感文件访问 —— 不处理就走不下去，或者你该马上知道',
  },
  {
    id: 'task',
    label: '任务结果',
    hint: '一轮跑完了（成功 / 失败 / 取消）',
  },
  {
    id: 'download',
    label: '下载',
    hint: '开始、完成、失败',
  },
  {
    id: 'agent',
    label: '过程播报',
    hint: '正在重试、换了供应商、上下文太长、在动网页',
  },
  {
    id: 'info',
    label: '日常确认',
    hint: '已保存、已复制、已加入队列 —— 多是你自己刚点的',
  },
]

/**
 * 默认去向 —— **右下角只弹「要你处理的事」**。
 *
 *   · error / needYou：必须看见，弹；
 *   · info：多是你自己刚点的动作，弹一下才算有反馈（任务中心里点「继续」
 *     没有任何回应，比弹一张卡难受得多）；
 *   · task / download / agent：那时你多半在看别处，弹出来只会打断 —— 进收件箱。
 */
export const DEFAULT_NOTIFY_ROUTES: NotifyRoutes = {
  error: 'toast',
  needYou: 'toast',
  task: 'center',
  download: 'center',
  agent: 'center',
  info: 'toast',
}

const ROUTE_VALUES: readonly NotifyRoute[] = ['toast', 'center', 'off']

/**
 * 把「可能是脏的」偏好归一化成完整的表（缺的、认不出的 → 默认值）。
 *
 * 为什么要它：这个字段没有自己的版本号（`useSettingsStore` 的 persist
 * version 已到 3，为它再升一次会把所有设置整体重写一遍），所以老版本
 * 升上来时它是 `undefined` —— 只能在这里补，且必须**每类独立**补：
 * 用户只改过 download 一类时，其余五类不能被一起重写成默认。
 */
export function normalizeRoutes(input: unknown): NotifyRoutes {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out = {} as NotifyRoutes
  for (const { id } of NOTIFY_CATEGORIES) {
    const value = raw[id]
    out[id] = ROUTE_VALUES.includes(value as NotifyRoute)
      ? (value as NotifyRoute)
      : DEFAULT_NOTIFY_ROUTES[id]
  }
  return out
}

/**
 * 一次提示该算哪一类。
 *
 * 输入是**调用方本来就知道的两件事**：语气（kind）和它带了什么按钮。
 * 不猜文案、不读全局状态 —— 那样会导致「同样一句话有时进收件箱有时弹」，
 * 用户永远说不清规律。
 *
 * @param kind 语气（success / error / info / warning）
 * @param hasAction 这张提示带不带按钮（带按钮的多半是「点一下去看」）
 * @param explicit 调用方直接点名的类别（比 kind 更准，优先用）
 */
export function categoryOf(
  kind: ToastKind,
  hasAction: boolean,
  explicit?: NotifyCategory,
): NotifyCategory {
  if (explicit) return explicit
  if (kind === 'error') return 'error'
  if (kind === 'warning') return 'agent'
  /*
   * info + 带按钮 = 有事要你去看（「查看结果」「查看」下载）——
   * 归到 needYou 而不是 info，因为**弹出来才有意义**：不弹的话那个按钮
   * 就没地方点了（它在收件箱里也能点，但用户不会知道有这回事）。
   * 不带按钮的 info 是纯确认（已保存 / 已加入队列）。
   */
  if (hasAction) return 'needYou'
  return 'info'
}

/** 这类通知此刻该怎么处理（每次现读设置，不在调用方缓存） */
export function routeFor(routes: NotifyRoutes | undefined, category: NotifyCategory): NotifyRoute {
  /* 传进来的是脏的（老配置 / 测试夹具只给了一部分）→ 这一项退默认 */
  if (!routes) return DEFAULT_NOTIFY_ROUTES[category]
  const value = routes[category]
  return ROUTE_VALUES.includes(value) ? value : DEFAULT_NOTIFY_ROUTES[category]
}
