/** 只在用户点击扩展图标后注入当前标签；不声明全站 content_script。 */
export function installSelectionToolbar() {
  if (document.getElementById('harbor-selection-trigger')) return
  const button = document.createElement('button')
  button.id = 'harbor-selection-trigger'
  button.type = 'button'
  button.textContent = '问 Harbor'
  button.setAttribute('aria-label', '把选中文字放入 Harbor 输入框')
  Object.assign(button.style, {
    position: 'fixed', zIndex: '2147483647', display: 'none', padding: '6px 10px',
    background: '#1d6ee8', color: 'white', border: '0', borderRadius: '8px',
    font: '13px sans-serif', cursor: 'pointer', boxShadow: '0 2px 10px #0005',
  })
  document.documentElement.appendChild(button)
  let selectedText = ''
  const show = () => {
    const selection = window.getSelection()
    const text = String(selection?.toString() || '').trim()
    const parent = selection?.anchorNode?.parentElement
    if (!text || parent?.closest('input,textarea,[contenteditable="true"]')) {
      button.style.display = 'none'
      return
    }
    selectedText = text.slice(0, 4000)
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
    if (!rect) return
    button.style.left = `${Math.min(innerWidth - 110, Math.max(4, rect.left))}px`
    button.style.top = `${Math.min(innerHeight - 35, Math.max(4, rect.bottom + 5))}px`
    button.style.display = 'block'
  }
  document.addEventListener('mouseup', () => setTimeout(show, 0))
  document.addEventListener('keyup', show)
  button.addEventListener('click', () => {
    const text = selectedText
    button.style.display = 'none'
    if (text) void chrome.runtime.sendMessage({ type: 'selection-draft', text, url: location.href })
  })
}
