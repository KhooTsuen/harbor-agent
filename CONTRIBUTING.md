# 贡献指南

这是自用项目。如果你（或未来的 AI 会话）要改它，先读这个。

> **给 AI 的话：先读 `AGENT.md`。** 那份是硬规矩、验证纪律和踩过的坑，
> 而且本应用会自动把它注入每轮对话 —— 规矩以它为准，这里不重复。

## 先跑起来

```bash
npm install
npm run dev        # Electron 版（能读写文件、跑命令、真终端）
npm run dev:web    # 浏览器演示版（mock 回复，不碰本机）
```

> `npm install` 之后如果终端功能不可用，见 `AGENT.md` 的坑清单
> （npm 11 会拦下原生模块的安装脚本，要手动补一步）。

## 改完自己验

具体命令和「为什么光看测试通过不够」写在 `AGENT.md`，
这里只说验收标准：

- [ ] `npm run typecheck` 0 错误
- [ ] `npm run lint` 0 错误 0 警告
- [ ] `npm run test:unit`（前端）全绿
- [ ] `npm test`（内核）全绿 —— **改 `electron/` 就必须跑这个**
- [ ] `npm run build` 通过
- [ ] 改到 UI / 会话 / 发送 → **真的手动走一遍**（用 `npm run shot:electron` 或自己点）
- [ ] `npm run package` 能打出来，且 `--self-test` 全 true

## 设计系统

**值的唯一来源**是 `src/constants/design.ts` 和 `src/constants/glass.ts`，
再由 `tailwind.config.js` 映射成 utility、`src/index.css` 输出成 CSS 变量。

改任何颜色 / 字号 / 圆角，去那两个文件，别在组件里写死。

两套主题并存：

- `default` —— 实测值（从 23 张同类界面截图里量出来的），**默认**
  （旧版本里这个主题叫 `codex`，会自动迁移）
- `chatgpt` —— 规范给的基准值
- `light` / `system` —— 亮色 / 跟随系统

玻璃拟态**默认关**（实测参考实现没有毛玻璃），用 `html[data-glass="on"]` 打开。

## 目录结构

```
electron/   主进程（CommonJS，管文件/命令/模型请求/终端/凭证）
src/        渲染层（React + TS）
  components/  ui / chat / layout / settings / dialogs / onboarding
  stores/     zustand（app / thread / settings / ui / config）
  hooks/      通用 React hooks
  lib/        backend / fs / workdir / export / schemas / highlight / markdown
  constants/  design / glass / index（快捷键、模型、布局尺寸）
docs/       安全模型 + 改造进度
scripts/    selftest（内核自测）/ build-portable / dev
tools/      shot（浏览器预览截图）/ shot-electron（真应用截图与驱动）
```

## 文档分工

| 文档 | 给谁看 | 什么时候更新 |
|---|---|---|
| `AGENT.md` | **AI 助手 + 本项目 Agent** | 规矩变了、踩了新坑 |
| `README.md` | 使用者 / 想了解全貌的人 | 加了功能、改了取舍 |
| `docs/安全模型.md` | 要碰安全相关的开发者 | 动了任何安全边界（含**没做什么**） |
| `docs/改造任务/PROGRESS.md` | 接手的人 / 别的模型 | 完成或放弃某条改造项 |
| `CHANGELOG.md` | 所有人 | 每次改动，写清**为什么** |
| `CONTRIBUTING.md` | 人 | 流程变了 |

**一条纪律**：同一个数字（比如测试项数、上限值）只在**唯一**一份文档里定义，
其他地方只引用、不复制 —— 复制了就会漂，这个项目已经漂过一次。
