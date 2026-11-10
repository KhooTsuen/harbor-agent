import { readMessageAnchor, type MessageAnchor } from './scrollAnchor'

export interface FlowScrollAccess {
  position: () => number
  seek: (top: number) => void
}

export interface FlowNavigationTarget {
  messageId: string
  targetId?: string
}

export interface FlowReadingPosition {
  top: number
  anchor: MessageAnchor | null
}

export const FLOW_NAVIGATION_EVENT = 'harbor:flow-navigate'
export const FLOW_REVEAL_EVENT = 'harbor:flow-reveal'
const access = new WeakMap<HTMLElement, FlowScrollAccess>()

export function registerFlowScroller(scroller: HTMLElement, controls: FlowScrollAccess) {
  access.set(scroller, controls)
  return () => {
    if (access.get(scroller) === controls) access.delete(scroller)
  }
}

export function navigateToFlow(messageId: string, targetId?: string) {
  window.dispatchEvent(
    new CustomEvent<FlowNavigationTarget>(FLOW_NAVIGATION_EVENT, {
      detail: { messageId, targetId },
    }),
  )
}

export function prepareFlowTarget(target: FlowNavigationTarget) {
  window.dispatchEvent(new CustomEvent<FlowNavigationTarget>(FLOW_REVEAL_EVENT, { detail: target }))
}

/** 前插步骤只补偿原节点的实际位移，沿用消息列表的程序滚动认领。 */
export function preserveFlowAnchor(element: HTMLElement): () => void {
  const scroller = element.closest<HTMLElement>('[data-flow-scroll-container]')
  const controls = scroller ? access.get(scroller) : undefined
  if (!controls) return () => {}
  const before = element.getBoundingClientRect().top
  return () => {
    if (!element.isConnected) return
    const delta = element.getBoundingClientRect().top - before
    if (Math.abs(delta) > 1) controls.seek(controls.position() + delta)
  }
}

export function readingPosition(scroller: HTMLElement): FlowReadingPosition {
  const content = scroller.firstElementChild
  return {
    top: scroller.scrollTop,
    anchor: content instanceof HTMLElement ? readMessageAnchor(scroller, content) : null,
  }
}

export function readingTop(scroller: HTMLElement, saved: FlowReadingPosition): number {
  const message = saved.anchor
    ? [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (node) => node.dataset.messageId === saved.anchor?.messageId,
      )
    : null
  return message && saved.anchor
    ? scroller.scrollTop +
        message.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        saved.anchor.offset
    : saved.top
}

export function revealFlowTarget(scroller: HTMLElement, target: FlowNavigationTarget) {
  const requested = target.targetId ? document.getElementById(target.targetId) : null
  const message = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')].find(
    (node) => node.dataset.messageId === target.messageId,
  )
  const node = target.targetId
    ? requested && scroller.contains(requested)
      ? requested
      : null
    : message
  if (!node) return null
  if (node instanceof HTMLDetailsElement) node.open = true
  let parent = node.parentElement
  const hidden: HTMLElement[] = []
  while (parent && parent !== scroller) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
    if (parent.getAttribute('aria-hidden') === 'true' && parent.id) hidden.push(parent)
    parent = parent.parentElement
  }
  for (const container of hidden.reverse()) {
    const button = [...scroller.querySelectorAll<HTMLButtonElement>('button[aria-controls]')].find(
      (candidate) => candidate.getAttribute('aria-controls') === container.id,
    )
    if (button?.getAttribute('aria-expanded') === 'false') button.click()
  }
  return node
}

/** 动画只用于用户主动发起的近距离定位，长距离直接落位。 */
export function moveToFlowTarget(
  scroller: HTMLElement,
  target: HTMLElement,
  controls: FlowScrollAccess,
): () => void {
  const start = controls.position()
  const top = Math.max(
    0,
    Math.min(
      scroller.scrollHeight - scroller.clientHeight,
      start + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16,
    ),
  )
  let frame = 0
  let timer = 0
  const highlight = () => {
    target.classList.remove('flow-target-highlight')
    target.classList.add('flow-target-highlight')
    timer = window.setTimeout(() => target.classList.remove('flow-target-highlight'), 1400)
  }
  if (
    document.documentElement.dataset.animations === 'off' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    Math.abs(top - start) > scroller.clientHeight * 1.5 ||
    Math.abs(top - start) < 8
  ) {
    controls.seek(top)
    highlight()
  } else {
    const began = performance.now()
    const step = (at: number) => {
      const progress = Math.min(1, (at - began) / 160)
      controls.seek(start + (top - start) * (1 - (1 - progress) ** 3))
      if (progress < 1) frame = window.requestAnimationFrame(step)
      else highlight()
    }
    frame = window.requestAnimationFrame(step)
  }
  return () => {
    window.cancelAnimationFrame(frame)
    window.clearTimeout(timer)
    target.classList.remove('flow-target-highlight')
  }
}
