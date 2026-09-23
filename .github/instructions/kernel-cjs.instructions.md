---
description: "改内核 electron/**/*.cjs 时的规矩：.cjs 不参与 tsc，必须跑内核自检；加 IPC 通道要同步清单"
applyTo: "electron/**/*.cjs"
---

# 改内核（`electron/`）

> 项目的总规矩在 [`AGENT.md`](../../AGENT.md)，这里只讲**改内核特有的**。

## 最容易犯的一条

**`.cjs` 不参与 `tsc`** —— 只跑 `npm run typecheck` 等于没验。改内核**必须**跑：

```
npm test
```

（内核自检 1800+ 项，直接 `require` 内核模块，**不需要 Electron、不联网** —— 这是整个项目可靠性的地基。）

## 硬规矩

- **内核不 `require('electron')`**。这是自检能跑起来的前提；要用 electron 的东西走**依赖注入**（放进 `ctx` 传进去）。
  唯一例外是 `credentials.cjs`：它**懒 require + try/catch**，因为要探测 `safeStorage` 可用性。
- **加 IPC 通道必须同步 `ipc-channels.cjs` 的 `EXPECTED_CHANNELS`**，否则打包自检报 `channelsMissing`（窗口照开、只是一个错误框，极难查）。
- **循环依赖用惰性 `require`**（在函数体内 require，别放模块顶层）。
- **单文件 ≤ 300 行**：`npm run check:lines`。
- **改数据结构必须写迁移，且保留旧数据**（用户已经有真实数据）。

## 拆分之前先看这两个坑

`docs/踩坑记录.md` 里记着，都真踩过：

1. **切片范围容易切多** —— 一次替换把相邻几个函数一起搬走，而且 **tsc 照样过**。
2. **拆一半比不拆更糟** —— 留个空函数占位就以为拆完了，**tsc/lint/全部测试全绿**，但流式内容、工具过程全都不再更新。

> **层与层之间的接线，测试照不到。** 拆完必须真跑一遍。

## 改完

```
npm run verify
```
