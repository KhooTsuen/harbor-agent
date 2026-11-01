/* global chrome */
import { installSelectionToolbar } from './selection-toolbar.js'

const MENU_ID = 'harbor-ask-selection'
let bound = false

export async function saveSelectionDraft(text, url) {
  const selection = String(text || '').trim().slice(0, 4000)
  if (!selection) return { ok: false, error: '没有选中文字' }
  const stored = await chrome.storage.local.get('harborSelected')
  const sessionId = String(stored?.harborSelected?.sessionId || '')
  await chrome.storage.local.set({ harborSelectionDraft: {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId, text: selection, url: String(url || ''),
  } })
  return { ok: true }
}

export async function showSelectionToolbar(tab) {
  if (!tab?.id || !/^https?:\/\//i.test(String(tab.url || ''))) return
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: installSelectionToolbar }) } catch { /* 受限页由浏览器拒绝 */ }
}

export function bindQuickEntry() {
  if (bound) return
  bound = true
  try {
    chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: MENU_ID, title: '用 Harbor 询问选中内容', contexts: ['selection'] }))
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      if (info.menuItemId !== MENU_ID) return
      const opened = tab?.windowId != null ? chrome.sidePanel.open({ windowId: tab.windowId }) : undefined
      await saveSelectionDraft(info.selectionText, info.pageUrl || tab?.url)
      await opened
    })
    chrome.commands.onCommand.addListener(async (command, tab) => {
      if (command !== 'open-panel') return
      if (tab?.windowId != null) {
        await chrome.sidePanel.open({ windowId: tab.windowId })
        await showSelectionToolbar(tab)
      }
    })
  } catch { /* 不支持快捷入口时保留图标主入口 */ }
}
