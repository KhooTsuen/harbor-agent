# Phase 1c 第一步：扩展构建链路验证报告

> **只读调研 + 一次构建链路实证（2026-10-15）。本步不写真正的侧边栏 UI（那是 1c 第二步）。**
>
> 一句话结论：**Harbor 现有依赖能编出一个 Edge 可加载的扩展页，且 Tailwind token 真的生效。**
> 路上撞到一个硬坑（Tailwind v3 加载不了带 `import` 的 ESM config），已定位并绕开。

---

## 1. 现有构建配置的形态

| 项 | 值 | 在哪 |
|---|---|---|
| Tailwind | **v3.4.14**（config-based，**不是** v4 CSS-first） | `package.json` devDependencies |
| Vite | 8.3.0（产物里可见 `rolldown-runtime`，即已切 rolldown） | `package.json` |
| React | 18.3.1 + `@vitejs/plugin-react` 6.1.1 | 同上 |
| PostCSS | `tailwindcss` + `autoprefixer`，**全局一份** | `postcss.config.js`（7 行） |
| Tailwind config | 231 行，`content: ['./index.html', './src/**/*.{ts,tsx}']` | `tailwind.config.js` |
| 主 Vite config | 87 行：`base:'./'`、`react()`、CSP meta 插件、`@` 别名、watch 忽略 | `vite.config.ts` |
| 主入口 | `index.html` → `/src/main.tsx` → 产物 `dist/` | 根 |
| 样式 | `src/index.css`（942 行：`@tailwind` ×3 + 主题变量 + 三个 `@layer`）+ `src/styles/theme-primer-dark.css` | `src/` |

**关键形态**：`tailwind.config.js` 的 `theme` 里，色值全是
`rgb(var(--bg-canvas-rgb) / <alpha-value>)` 这种**通道模式** ——
**类名映射到 CSS 变量，变量本身在 `src/index.css` 里**。
所以「只继承 theme」是不够的，必须同时拿到那些变量。这正是本步要验的核心。

---

## 2. 扩展页的独立 Vite 配置（草案）

`harbor-edge/vite.config.ext.ts`（48 行），三处与主应用不同：

| # | 项 | 值 | 为什么 |
|---|---|---|---|
| ① | `root` | `harbor-edge/src/sidepanel` | 让 `index.html` 与 `main.tsx` 同层，入口解析与 `base:'./'` 相对路径自然成立 |
| ② | `css.postcss` | `harbor-edge/postcss.config.js` | **必须给文件路径**，见 §4 的坑 |
| ③ | `build.outDir` | `harbor-edge/dist/sidepanel` | **不碰主应用 `dist/`** —— 扩展是独立交付物 |

`base: './'` 与主应用同理由：扩展页由浏览器以 `chrome-extension://<id>/sidepanel/index.html`
加载，绝对路径 `/assets/…` 会解析到扩展根。

用法（在项目根跑）：

```
npx vite build --config harbor-edge/vite.config.ext.ts
```

---

## 3. Tailwind 扫描范围的调整方案

**方案：theme 继承、content 独立。**

- `content` = `['./harbor-edge/src/**/*.{ts,tsx,html}']` —— **只扫扩展**。
  理由两条：① 不把扩展的类渗进主应用 CSS 产物；② 主应用构建不用多扫一遍扩展（扩展会长大）。
- `theme` = 主 config 的 `theme` **同一份对象**（不抄）。抄一份迟早和 `src/index.css` 漂。
- `plugins` = 主 config 的（当前 `[]`），跟着走。

**样式入口**：`harbor-edge/src/sidepanel/sidepanel.css` 直接
`@import '../../../src/index.css'` —— 拿 `@tailwind` 三指令 + 主题变量 + `@layer`。
Vite 内建处理 CSS `@import`（不需要 `postcss-import`），这条一并验过。

> ⚠️ **给 1c 第二步留的账**：现在是把主 `index.css` **整份**引进来 ——
> 主应用 `@layer components` 里那一堆组件样式（942 行里的 551–882 段）也会进扩展产物。
> 本步 CSS 产物 12.25 kB 说明 Tree-shaking 起了作用（Tailwind 的 `@layer components`
> 只在类被用到时才输出），但**真 UI 阶段要重新评估**：可能需要拆一份
> 「只有 token + 少量基础层」的共享 CSS。**本步只验能不能通，未做这个拆。**

---

## 4. ★ 实测撞到的硬坑（已定位并绕开）

**首次构建直接失败**，错误信息看不出跟配置有关：

```
[plugin vite:css] sidepanel.css:undefined:NaN
SyntaxError: [postcss] Unexpected token (6:69)
    at unexpected (node_modules/sucrase/dist/parser/traverser/util.js:99:15)
```

堆栈**全是 `sucrase`**（一个 TS 解析器）+ 前缀 `[postcss]` → 指向「PostCSS/Tailwind
在解析某个 JS 文件时炸了」，不是 CSS 本身。

**根因（试出来的，两次对照）**：我最初写了 `harbor-edge/tailwind.config.ext.js`，
里面用 `import base from '../tailwind.config.js'` 取 theme。
→ **Tailwind v3 的 config 加载器用它自己的解析器（sucrase），处理不了带 `import` 的 ESM config。**

**对照证据**：项目根 `tailwind.config.js` 能正常工作，它**只有 `export default`、没有任何 import**
—— 唯一差别就在这。

**解法**：让 Tailwind 收到一个**纯对象**（不加载任何文件）——
把组装逻辑放进 `harbor-edge/postcss.config.js`（这个文件由 Vite 正常加载，ESM/TS 都走 Vite 管线）：

```js
import base from '../tailwind.config.js'
export default {
  plugins: {
    tailwindcss: {
      config: {
        content: ['./harbor-edge/src/**/*.{ts,tsx,html}'],
        theme: base.theme,          // 同一份对象，不抄
        plugins: base.plugins ?? [],
      },
    },
    autoprefixer: {},
  },
}
```

顺带好处：theme 只有一处来源，不会漂。**删掉了那个多余的 `tailwind.config.ext.js`。**

**第二个坑（同一处，不同表现）**：`vite.config.ext.ts` 里 `css.postcss` 我一开始传的是**目录**
（`harbor-edge/`）—— Vite 会把它当配置文件去打包，报**同一个**看不懂的 postcss 语法错。
**必须给文件路径**。已修 + 在配置里写了注释。

---

## 5. 实测：能否 build 出可加载的 sidepanel.html

### 5.1 构建 ✅

```
npx vite build --config harbor-edge/vite.config.ext.ts
  ✓ 14 modules transformed
  harbor-edge/dist/sidepanel/index.html                   0.53 kB
  harbor-edge/dist/sidepanel/assets/index-CPN2RZtt.css   12.25 kB │ gzip: 3.83 kB
  harbor-edge/dist/sidepanel/assets/index-D33blBDS.js   141.06 kB │ gzip: 45.91 kB
  ✓ built in 1.15s
```

**产物结构正确**：`index.html` 里引用 `./assets/…`（相对路径）、CSS 与 JS 分离、
没有内联脚本（扩展 CSP 友好）。JS 141 kB 主要是 React 本身，属预期。

### 5.2 CSS 里类与变量都在 ✅

| 检查 | 结果 |
|---|---|
| 9 个类全部编出 | `.bg-canvas` `.text-fg-primary` `.text-title` `.text-accent` `.rounded-base` `.bg-bg-raised` `.border-line-hairline` `.text-fg-secondary` `.text-meta` —— **全在** |
| 5 个 CSS 变量同现 | `--bg-canvas` `--bg-raised` `--text-primary` `--text-secondary` `--accent-blue` —— **全在** |

### 5.3 ★ 真机加载 + 样式真的生效（6/6）✅

`harbor-edge/tools/accept-sidepanel.cjs`：把产物包成最小 MV3 扩展 →
起**隔离** Edge（独立 profile）→ CDP 读回渲染结果与 **computed style**。

```
extension id = lmmkajddbajlljodmiakijlihiljnjma
rendered = {
  "title": "Harbor",
  "text": "Hello Harbor\n\nsidepanel build-chain probe（Phase 1c step 1）\n\ntoken probe",
  "rootBg": "rgb(16, 16, 16)",
  "h1Color": "rgb(248, 248, 248)",
  "h1Size": "24px",
  "nodeCount": 15,
  "stylesheets": 1
}

PASS ① 页面打开并读到 DOM                    节点数=15
PASS ② React 挂载（"Hello Harbor" 渲染出来）
PASS ③ ★ CSS 变量真的生效（背景色算得出实值）  background-color=rgb(16, 16, 16)
PASS ③b ★ 文字色也走变量（--text-primary）     color=rgb(248, 248, 248)
PASS ③c 自定义字号 token 生效（--text-title）   font-size=24px
PASS ④ 外部样式表被加载                       stylesheets=1
==== 6/6 通过 ====
```

**为什么 ③ 是强判据**：它读的是**实际像素值**，不是类名。
若 CSS 变量没定义，`.bg-canvas` 的 `background-color` 会算成 `rgba(0, 0, 0, 0)`（透明）
→ 这条直接红。现在算得出 `rgb(16,16,16)`（= `var(--bg-canvas-rgb)` = `16 16 16`），
说明 **theme 映射 + 变量定义 + Vite CSS 处理三者真的接上了**。

### 5.4 主应用构建未受影响 ✅

`npm run build` 成功（4513 modules），且 **`dist/assets/index-BrVZjSWd.css` 的 hash 与改动前一致**
（见 §1 读到的旧产物 vs 新产物同为 `index-BrVZjSWd.css`，47.30 kB）
—— 硬证据：**扩展的类没有渗进主应用 CSS**。

---

## 6. 过程中修掉的两个不确定性

1. **验收脚本首次跑读不到扩展 ID（假红）** —— `waitMs` 定 3000 时 Edge 还没把
   `Secure Preferences` 写盘。改成**轮询读 ID（最多 15 秒）**。
   与 Phase 1b 的 `read-extid` 同一个教训：**别信固定等待**。
2. **脚本抛错时遗留了隔离 profile** —— 加 `try/finally`，无论成败都杀进程 + 删 profile。

---

## 7. 新增/改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `harbor-edge/postcss.config.js` | 新（51 行） | 扩展侧 PostCSS：theme 继承主 config、content 只扫扩展 |
| `harbor-edge/vite.config.ext.ts` | 新（48 行） | 扩展独立构建配置草案 |
| `harbor-edge/src/sidepanel/index.html` | 新（14 行） | 最小扩展页 |
| `harbor-edge/src/sidepanel/main.tsx` | 新（40 行） | 只有 "Hello Harbor" + token 探针 |
| `harbor-edge/src/sidepanel/sidepanel.css` | 新（22 行） | `@import` 主 index.css |
| `harbor-edge/tools/accept-sidepanel.cjs` | 新（178 行） | 真机加载验收 |
| `.gitignore` | 改 | 加 `harbor-edge/dist/` |

**未改**：`electron/**`（零改动）· `src/**`（零改动）· `tailwind.config.js` / `vite.config.ts` /
`postcss.config.js`（根）· `package.json`（**零新依赖**）。

---

## 8. 已知遗留（给 1c 第二步）

1. **主 `index.css` 是整份引入的** —— 真 UI 阶段要评估是否需要拆出「只含 token」的共享 CSS（见 §3 的账）。
2. **`main.tsx` 是探针内容**，不是真 UI（按你的要求）。
3. **`harbor-edge/ext/`（Phase 1b 探针扩展）保留未动** —— 按你的要求。
4. **`harbor-edge/dist/` 已忽略**，但每次构建会重建；没做成 npm script（本步只验链路，
   要不要在 `package.json` 加 `build:ext` 脚本属 1c 第二步的决策）。
5. **`side_panel.default_path` 指向 `index.html`** 是验收用的临时 manifest；
   真扩展的 manifest 在 1c 第二步定。

---

## 9. 是否违反约束

零新依赖 ✓ · 未碰 `electron/**` ✓ · 未碰 Runtime / 严格模式 / 防闪烁 / `hardenWebview` /
工具系统 / 权限模型 ✓ · 未写真 UI ✓ · 未改根构建配置 ✓ · 单文件全 ≤300 ✓ ·
探针全隔离（独立 profile，跑完即删）✓ · 未碰用户正在用的 Edge / `E:\Harbor` / `E:\Harbor-Dev` ✓

---

## 10. 取证文件清单

- 配置：`harbor-edge/postcss.config.js`、`harbor-edge/vite.config.ext.ts`
- 入口：`harbor-edge/src/sidepanel/{index.html,main.tsx,sidepanel.css}`
- 验收：`harbor-edge/tools/accept-sidepanel.cjs`
- 构建产物：`harbor-edge/dist/sidepanel/{index.html,assets/*.css,assets/*.js}`（已忽略）
