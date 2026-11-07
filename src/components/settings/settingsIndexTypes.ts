import type { SettingsTabId } from './parts'

/* 设置搜索索引的**条目形状**（数据在两个 settingsIndex*.ts 里，这里只定义类型）

   单独一个文件是为了让「类型」与「数据」各自不贴 300 行红线。 */

export interface SettingsEntry {
  /** 属于哪一页（点结果就跳过去） */
  tab: SettingsTabId
  /** 这一项在界面上叫什么 */
  label: string
  /** 一句话解释（结果里显示，帮用户确认是不是他要的） */
  hint: string
  /** 用户可能搜的其他叫法：同义词、常见中文说法、专业词 */
  keywords: string[]
}
