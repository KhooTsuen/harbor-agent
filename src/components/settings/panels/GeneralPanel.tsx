import { GeneralTab } from '../tabs/GeneralTab'
import { ShortcutsTab } from '../tabs/ShortcutsTab'

/* ══════════════════════════════════════════════════════════════
   通用 = 启动与窗口 + 快捷键

   快捷键原来单独占一个标签，但它不是天天改的东西 ——
   和「窗口/托盘」放一起，左侧能少一格。
   ══════════════════════════════════════════════════════════════ */

export function GeneralPanel(): React.ReactElement {
  return (
    <>
      <GeneralTab />
      <div className="mt-4 border-t border-line-hairline pt-2">
        <ShortcutsTab />
      </div>
    </>
  )
}
