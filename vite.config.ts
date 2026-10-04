import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

/*
 * 版本号从 package.json 读进来注入。
 *
 * 踩过：`src/lib/backend.ts` 是 `import.meta.env.VITE_APP_VERSION ?? '0.1.0'`，
 * 而这个环境变量**从来没被设置过** —— 于是「关于」页一直显示硬编码的 **0.1.0**，
 * 而项目早就过了 0.29.0。改了近三十个版本，关于页一次都没变。
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/*
 * CSP（审计问题 19）。**只在打包时注入**。
 *
 * 为什么不写进 `index.html`：开发模式下 Vite 要往页面里插**内联脚本**
 * （HMR 客户端、React 刷新运行时），`script-src 'self'` 会把它们直接拦死。
 * 取舍说清楚：开发环境因此不受这套 CSP 约束 —— 宁可少一层，也不要开发模式坏掉；
 * 反过来（给 dev 单独放宽）等于维护两套规则，早晚漂。
 *
 * 口径按**实际需要**收，每一条都对着代码核过，并在真机上验过「没拦住界面」：
 *   · script-src 'self'          —— 渲染层没有 eval / new Function（grep 核过）
 *   · style-src  'unsafe-inline' —— 组件里大量 `style={{…}}`，绕不过去
 *   · img-src    加 data:/blob:/file:/https: —— 头像与背景来自本地文件，
 *                聊天图片可能是 data URL（粘贴、生成）或模型给的外链
 *   · connect-src 'self'         —— 渲染层不直连网络（HTTP 全在主进程），grep 核过没有 fetch
 *   · object-src / base-uri / form-action —— 这三样应用根本不用，直接关掉
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: file: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

/** 打包产物里插一条 CSP meta（开发模式不插，见上面那段） */
function cspMeta(): Plugin {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`
  return {
    name: 'harbor-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('</head>', `  ${tag}\n  </head>`)
    },
  }
}

export default defineConfig({
  /* Electron 用 file:// 加载 dist/index.html，
     绝对路径 /assets/... 会解析到磁盘根目录，必须是相对路径 */
  base: './',
  plugins: [react(), cspMeta()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    open: false,
    /*
     * 开发服务器**必须**绕开这些目录。2026-09-29 实测的崩法：
     * 应用在开发模式下会把 Chromium 配置写进 `data/chromium/`（那是运行时数据），
     * 而 vite 的监视器默认从项目根往下爬 → 撞上被锁的 `data/chromium/Network/Cookies`
     * → `EBUSY: resource busy or locked` → **vite 直接退出**，开发模式起不来。
     *
     * 这些目录都不是源码：data/ 是运行时数据，其余是构建产物 / 临时目录 / 依赖。
     * 顺带也省掉一大堆无意义的文件监视。
     */
    watch: {
      ignored: ['**/data/**', '**/dist/**', '**/dist-portable/**', '**/tmp/**', '**/shots/**', '**/test-env/**', '**/backups/**'],
    },
  },
})
