/// <reference types="vite/client" />
import type React from 'react'

declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      src?: string
      allowpopups?: boolean
      partition?: string
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   环境变量类型声明

   这些变量的说明和默认值见 .env.example。
   不声明的话 import.meta.env.XXX 全是 any（会被 no-explicit-any 拦）。
   ══════════════════════════════════════════════════════════════ */

interface ImportMetaEnv {
  /** 仅 Vite 开发预览：'1' = 使用静态回复；生产 Electron 忽略该变量 */
  readonly VITE_USE_MOCK?: string
  /** 显示在「关于」页的版本号 */
  readonly VITE_APP_VERSION?: string
  /** 默认接口地址（可选） */
  readonly VITE_API_ENDPOINT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
