/* global chrome */
import { useEffect, useRef } from 'react'

interface SelectionDraft { id?: string; sessionId?: string; text?: string; url?: string }

/** 右键/选区按钮只填草稿；会话不符时留在 storage 等用户切回。 */
export function useSelectionDraft(sessionId: string, append: (owner: string, text: string) => void) {
  const handled = useRef('')
  useEffect(() => {
    const apply = (draft?: SelectionDraft) => {
      if (!draft?.id || draft.id === handled.current || String(draft.sessionId || '') !== sessionId) return
      const quote = String(draft.text || '').trim().slice(0, 4000)
      if (!quote) return
      handled.current = draft.id
      const url = String(draft.url || '')
      append(sessionId, `> ${quote.replace(/\n/g, '\n> ')}${url ? `\n\n来源：${url}` : ''}`)
      void chrome.storage.local.get('harborSelectionDraft').then((out) => {
        if (out?.harborSelectionDraft?.id === draft.id) return chrome.storage.local.remove('harborSelectionDraft')
      }).catch(() => {})
    }
    const onChanged = (changes: Record<string, { newValue?: SelectionDraft }>, area: string) => {
      if (area === 'local') apply(changes.harborSelectionDraft?.newValue)
    }
    chrome.storage.onChanged.addListener(onChanged)
    void chrome.storage.local.get('harborSelectionDraft').then((out) => apply(out?.harborSelectionDraft)).catch(() => {})
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [sessionId, append])
}
