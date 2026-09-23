---
description: "改渲染层 src/** 时的规矩：类型零容忍、设计值唯一来源、UI 改动必须真跑一遍"
applyTo: "src/**/*.{ts,tsx}"
---

# 改渲染层（`src/`）

> 项目的总规矩在 [`AGENT.md`](../../AGENT.md)，这里只讲**改渲染层特有的**。

## 硬规矩

- **类型零容忍**：禁 `any` / `@ts-ignore` / `eslint-disable`。
  外部数据（磁盘 / 网络 / localStorage）进来**先过** `src/lib/schemas.ts` 的 zod 校验。
- **设计值只在 `src/constants/` 定义**，别处只引用、不复制 —— 复制就会漂。
- **状态词只有一份**：`src/lib/statusLanguage.ts`（AG-031 有执法测试盯着，别在组件里另编一套）。
- **单文件 ≤ 300 行**：`npm run check:lines`。

## 两个真踩过的坑

1. **selector 别每次读都新建对象。**
   `zustand` 默认用 `Object.is` 比结果 —— 每次现造一个新对象就等于「每次都变了」，
   组件重渲染 → 下面的 effect 又跑一遍。实测后果：`fs:tree` 在同一秒被调几十次。
   修法：包 `useShallow`；effect 的依赖用**原始值**（如 `project?.path`），别用整个对象。
2. **React 受控输入要用原生 setter + `input` 事件**才能触发变更
   （`Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set`）——
   直接赋 `.value` 不会让 React 知道。写测试/脚本驱动界面时必踩。

## UI 改动必须真跑一遍

`npm test` 只能证明「机制在」，证明不了「看得见、按得动」。
本项目有两次事故（**发不出消息**、**流式内容全不更新**）**都过了 tsc + lint + 全部测试**。

```
npm run shot:electron -- --exe=dist-portable/Harbor/Harbor.exe
```

## 改完

```
npm run verify
```
