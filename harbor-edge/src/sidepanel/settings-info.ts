/**
 * M02-C：**设置抽屉的纯逻辑**（不碰 React、不碰 chrome）
 *
 * ── 为什么从 `SettingsDrawer.tsx` 抽出来 ────────────────────────
 *
 * `capabilitiesOf()` 是「这个扩展能干什么」的**唯一算法** —— 设计文档明写
 * 「从 manifest 的 permissions 现算，不手写」（手写的清单会在改 manifest 时偷偷过期，
 * 而用户是拿它判断能力的）。这条算法如果只活在 `.tsx` 里，自检就**测不到**
 * （Node 不认 JSX），而它恰恰最该被钉住：算错了，界面会告诉用户一个不存在的权限，
 * 或者藏掉一个真有的权限。
 *
 * 抽出来后：`SettingsDrawer.tsx` 只负责画，本文件被 `177-m02c-settings.mjs` 直接跑。
 */

/** native host 的名字（`install-host.cmd` 写进注册表的那个） */
export const HOST_NAME = 'com.harbor.agent'

/**
 * 权限名 → 人话。
 *
 * ⚠️ 只覆盖**我们真用了**的那几个；表里没有的权限在界面上**原样显示名字**
 * （宁可难看，也不要编一句话骗用户）。
 */
export const PERMISSION_TEXT: Record<string, string> = {
  nativeMessaging: '和本机的 Harbor 通信（唯一的数据通道）',
  sidePanel: '在浏览器右侧显示侧边栏',
  storage: '在浏览器本地记状态（设置、上次读的页面；不上传）',
  activeTab: '你点扩展图标时，读当前标签页的地址与正文（只授权这一个标签，换页要再点一次）',
  scripting: '把采集脚本注入你当前打开的页面（只读页面内容）',
  tabs: '读取所有标签页的地址（产品**没要**这个权限）',
  contextMenus: '选中文字时显示「用 Harbor 询问」右键入口',
  commands: '键盘快捷键打开侧边栏',
}

/**
 * 可选权限（`optional_host_permissions`）的人话。
 *
 * ⚠️ 与上面那张表的区别：那些是**安装时就生效**的权限；这里是**默认不生效、
 *    要用户主动点开关才会弹框申请**的能力。混在一起会让人以为装完就能读全站。
 */
export const OPTIONAL_TEXT = '可选：整站读取（默认没开；在设置抽屉的「整站读取」里打开后才生效，也可以只对单个站点「记住本页」）'

/** 一条能力的展示形状 */
export interface Capability {
  /** 权限原名（未知权限靠它显示，不隐藏） */
  name: string
  /** 人话解释（未知时等于 name） */
  text: string
  /** 这张表里认得它吗（不认得的要显式标出来，别混在「已解释」里） */
  known: boolean
}

/**
 * 从 manifest 算出能力清单 —— **纯函数**，自检能直接跑。
 *
 * @param {{ permissions?: string[], host_permissions?: string[], optional_host_permissions?: string[] } | null} manifest
 * @returns {{ capabilities: Capability[], hostPermissions: string[], optionalHostPermissions: string[] }}
 */
export function capabilitiesOf(manifest: {
  permissions?: string[]
  host_permissions?: string[]
  optional_host_permissions?: string[]
} | null): { capabilities: Capability[]; hostPermissions: string[]; optionalHostPermissions: string[] } {
  const list = Array.isArray(manifest?.permissions) ? manifest!.permissions : []
  const capabilities = list.map((name) => {
    const key = String(name ?? '')
    const text = PERMISSION_TEXT[key]
    return text ? { name: key, text, known: true } : { name: key, text: key, known: false }
  })
  const host = Array.isArray(manifest?.host_permissions) ? manifest!.host_permissions : []
  /* 可选权限单独一条出口：它**默认不生效**，混进 capabilities 会让人以为装完就能读全站 */
  const optional = Array.isArray(manifest?.optional_host_permissions) ? manifest!.optional_host_permissions : []
  return { capabilities, hostPermissions: host.map(String), optionalHostPermissions: optional.map(String) }
}

/** 站点策略只存 Harbor 主进程，侧边栏操作的是同一份数据。 */
export const SITES_POINTER =
  '站点黑名单由 Harbor 主应用统一管（和权限、审计同一处）。下方操作直接修改 Harbor 的同一份策略，不会在扩展另存一份。'
