import type { DetailedHTMLProps, HTMLAttributes } from 'react'

/* ══════════════════════════════════════════════════════════════
   <webview> 的类型声明

   它是 Electron 提供的自定义元素，React 不认识，不声明的话写
   `<webview src=... />` 会报「不存在这个 JSX 元素」。

   只声明实际用到的属性 —— 全量声明（Electron 有一大堆方法）没意义，
   用到了再加。
   ══════════════════════════════════════════════════════════════ */

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        /** 允许网页自己开新窗口（"true" 是字符串，Electron 的约定） */
        allowpopups?: string
        partition?: string
        /** 防止网页里的脚本拿到宿主环境 */
        webpreferences?: string
      }
    }
  }
}
