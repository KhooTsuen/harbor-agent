# M03 设计说明：网页感知补完（选区 / 元素列表 / 能力检测 / 页面版本号）

> **状态**：**已完成**（2026-10-16；实测见文末 §8）。**范围**：只做「看」，不做「动」。
> **模块进度看** [`edge-extension-roadmap.md`](edge-extension-roadmap.md)（M01–M12 的唯一真相源）——
> 本文只讲 M03 自己。
> **依据**：《Harbor Agent Browser Extension》§2 M03、§4.4 协议、§4.5 工具清单、§5.1 权限等级、§6 成本预算。
> **前置**：`docs/research/edge-extension-phase3a-design.md`（帧协议）、`edge-extension-phase3b-design.md`（落盘与推送）。
> **红线**：零新依赖 · 不碰 Runtime / 严格模式 / 防闪烁 / `hardenWebview` / 工具系统 / 权限模型 · 单文件 ≤300。

---

## 0. M03 现状与缺口

| 文档要求 | 现状 | 本轮 |
|---|---|---|
| 页面元数据（URL / 标题 / 可见文本） | ✅ 有（`ext:page`） | 保留不动 |
| **选区与局部 DOM 提取** | ❌ 无 | **加** |
| **交互元素结构（角色 / 可见性 / 标签 / 状态）** | ❌ 无 | **加** |
| **iframe / Shadow DOM 能力检测 + 明确不可访问报告** | ❌ 无 | **加** |
| **元素引用 + 页面版本号** | ❌ 无 | **加** |
| 阅读模式正文提取（标题层级 / 表格 / 图片 alt） | ⚠️ 只有 `innerText` | **本轮不做**（记为遗留） |
| SPA DOM 更新观察 / 页面稳定判断 | ❌ 无 | **本轮不做**（M04 的 wait 一起做） |

---

## 1. ★ 一个必须先说清的约束：注入函数的形态

现有读页面走 `chrome.scripting.executeScript({ func })`（**按需注入**，manifest 里**没有** `content_scripts`）。

**`func` 会被 `Function.prototype.toString()` 序列化后注入页面** —— 所以：

> **采集器内部只能引用它自己的参数和嵌套定义的函数。引用任何模块级常量 / 导入，注入后都会 `ReferenceError`。**

这条**必须写在采集器文件头**：它是「本地跑得好好的、真机上就 undefined」的那类坑，而且**只有真机能现形**（单测在 Node 里能直接 require 那个函数，永远看不出问题）。

**后果**：采集器写成 `lib/observe.js` 里的**一个大自包含函数**（内部嵌套所有辅助函数），文件里**只导出它**，不导出辅助常量。

---

## 2. 元素引用（ref）与页面版本号

### 2.1 ref 格式

```
<pageVersion>.<n>        例：a1b2c3d4.e12
```

- `n`：本次观察里第 n 个被登记的元素（从 1 计）。
- **ref 自带版本号** → 拿旧 ref 来操作时，**字符串比对就能判失效**，不必再问一次页面。

### 2.2 元素登记（给 M04 用）

每次观察时，把元素存进页面上的一个**采集命名空间**：

```js
window.__harborObs = {
  version: '<pageVersion>',
  refs: Map<ref, WeakRef<Element>>,   // WeakRef：不阻止页面回收，不泄漏
}
```

- 用 `WeakRef`（不是强引用）—— 否则一次观察就把整页元素钉在内存里。
- **旧版本那一份直接丢掉**（只留最近一次）—— 免得 M04 拿两个版本的 Map 混淆。

### 2.3 页面版本号算法（同步、廉价、稳定）

```
pageVersion = fnv1a( url + '\u0001' + title + '\u0001' + 元素签名拼接 + '\u0001' + 正文长度 )
```

- **FNV-1a（32 位）** 而不是 `crypto.subtle`：后者是**异步**的，而指纹要参与「同步生成 ref」；FNV-1a 十几行、CPU 可忽略。
- 元素签名 = 前 200 个可交互元素的 `role|tag|文本(截 30) |disabled|checked` 拼接 —— **结构或文案变一个字符，指纹就变**。
- **纳入 URL**：导航即换版本（文档要求「页面改变后旧元素引用失效」）。
- **不纳入时间戳**：同一页面反复观察必须得到**同一个** version（否则「没变」判断不出来）。

### 2.4 失效判据（M04 直接用）

| 情形 | 判据 | 处理 |
|---|---|---|
| 页面结构变 | `ref 前缀 ≠ 当前 pageVersion` | 拒绝 + 要求重新观察 |
| 元素被移除 | 登记表里查不到 / `WeakRef.deref() === undefined` | 同上 |
| 元素不再可见 | 操作前再查一次可见性（M04） | 拒绝 + 报告 |

---

## 3. 返回值形状

对齐文档 §4.4（`requestId` / `pageVersion` / `truncated` / `source` 都在）：

```jsonc
{
  "ok": true,
  "source": "extension",
  "url": "https://…", "title": "…", "lang": "zh-CN",
  "pageVersion": "a1b2c3d4",
  "at": 1792000000000,

  "selection": {                    // 无选区 = null
    "text": "选中文字（≤ 4000 字符）",
    "ref": "a1b2c3d4.e3",           // 选区所在元素的 ref
    "tag": "P", "truncated": false
  },

  "elements": [{                    // 可交互元素
    "ref": "a1b2c3d4.e1", "role": "button", "tag": "BUTTON",
    "text": "提交",                  // 可见文本（≤ 80 字符）
    "disabled": false, "checked": null,
    "value": null,                  // 敏感字段 → null + masked:true
    "masked": false,
    "placeholder": "", "href": "",  // href 截断到 200
    "visible": true
  }],

  "frames": [{                      // iframe 逐个报告（不捏造）
    "index": 0, "src": "https://…", "title": "",
    "accessible": false, "reason": "跨域（浏览器不允许读）"
  }],

  "shadow": { "open": 2, "note": "closed shadow root 无法枚举（浏览器不暴露）" },

  "stats": { "elements": 60, "maxItems": 60, "truncated": true, "textLen": 18342 }
}
```

### 3.1 敏感字段遮蔽（M07 要求，M03 就做）

**判定**：`input[type=password]` **或** `name / id / autocomplete / aria-label` 命中敏感词表
（`password|passwd|pwd|card|cc-number|cvv|ssn|secret|token|otp|verification|验证码|密码`）。

**处理**：`value: null` + `masked: true`。**不返回任何字符**（连长度都不给 —— 长度也是信息）。

### 3.2 能力检测：读不到就如实说，不捏造

| 情形 | 返回 |
|---|---|
| 同源 iframe | `accessible: true`，并可继续读到它内部（本轮只报告，不递归采集） |
| 跨域 iframe | `accessible: false` + `reason`，**内容字段一律空**（不填「可能的内容」） |
| open shadow root | 计入 `shadow.open`，其内部元素**正常参与扫描** |
| closed shadow root | **检测不到**（`element.shadowRoot === null`）→ 只在 `note` 里说明「无法枚举」，**不猜数量** |
| 浏览器内部页（`edge://` 等） | SW 层早退（复用现有 `BLOCKED_PROTOCOL`），回人话 |

---

## 4. 预算（文档 §6）

| 项 | 默认 | 超限行为 |
|---|---|---|
| `maxItems`（元素条数） | 60 | 截断 + `stats.truncated = true` |
| 单个文本字段 | 80 字符 | 截断加 `…` |
| 选区文本 | 4000 字符 | 截断 + `truncated: true` |
| 正文（`ext:page` 那条，不动） | 512 KB | 既有行为 |

**先截图结构与元素引用，再按需读局部细节**（文档 §6.2）—— 所以元素列表给**引用 + 短文本**，不给整段 `outerHTML`。

---

## 5. 链路与落点

```
侧边栏「观察页面」按钮
  → SW  observe-page  → chrome.scripting.executeScript({ func: collectPageContext })
  → SW  requestHost('page:observe', { observation })
  → host 转发（ext-host-loop 加一个 type）
  → 主进程 ext-ops → ext-observe.renderObservation()（渲染成 markdown + 预算）
  → 复用既有的「包装 → 落会话 → 审计 → 推渲染层」四步（与 ext:page **同一套**）
```

**为什么复用 `ingestPage` 那条链**：文档 §7 要求「不建立第二套真相来源」；`wrapWebText`（防注入包装）、审计、推送三件事**各只有一份实现**（硬约束 #9）。

**与 `ext:page` 的关系**：**并存，不替代**。
- `ext:page`：只要正文（现有按钮，一个字节不动 → 3a / 3b / phase2 验收不回归）。
- `page:observe`：结构化观察（M03 新增）。

---

## 6. 新增的协议与文件

| 位置 | 加什么 |
|---|---|
| `electron/core/ext-protocol.cjs` | `KIND.PAGE_OBSERVE = 'page:observe'` |
| `electron/core/ext-observe.cjs` | **新**：观察结果 → markdown（含预算裁剪；不 require electron） |
| `electron/core/ext-ops.cjs` | 分派一条 |
| `electron/core/ext-host-loop.cjs` | host 转发 `observe-page` |
| `harbor-edge/extension/lib/observe.js` | **新**：自包含采集器 + FNV-1a 指纹 |
| `harbor-edge/extension/service-worker.js` | `observe-page` 消息处理 |
| `harbor-edge/src/sidepanel/ObserveButton.tsx` | **新**：侧边栏那个按钮（与 `ReadPageButton` 平行） |
| `ChatPanel.tsx` | 输入框左端放第二个按钮 |

**不新增 IPC 通道**（走既有 `ext:page` 推送把结果告诉渲染层 —— 主窗口会看到那条会话更新了）。

---

## 7. M03 验收判据（真机，真页面）

| # | 判据 |
|---|---|
| ① | 选区：框选一段文字 → 观察结果里有那段文本 + 所在元素 ref |
| ② | 元素列表：页面上真有按钮/输入框被列出，`role` / `text` / `disabled` 对得上 |
| ③ | 敏感字段：`type=password` 的输入框 `value` 为 `null` 且 `masked: true` |
| ④ | 跨域 iframe：`accessible: false` + 人话原因；**不出现任何正文** |
| ⑤ | 同源 iframe：`accessible: true` |
| ⑥ | 页面版本号：同一页面反复观察**结果相同**；改动 DOM 后**结果变化** |
| ⑦ | ref 带版本号：ref 形如 `<version>.<n>`；页面变了旧 ref 前缀 ≠ 新 version |
| ⑧ | 落进 Harbor：观察结果出现在会话里，且过了 `wrapWebText`（含防注入抬头） |
| ⑨ | 预算：元素超过 maxItems 时 `truncated: true`，条数 = maxItems |
| ⑩ | 不回归：`accept-phase2` / `3a` / `3b` / `3c` 全绿 |

第 ⑥ 条是**最关键的一条** —— 它同时守住「稳定」和「能变」两个相反的失败模式（都变了 = 假失效；都不变 = 假有效）。

---

## 8. 实测结果（2026-10-16 完成）

**真机 `harbor-edge/tools/accept-m03.cjs`：31/31**（真 Edge + 真页面 + 真 CDP）。

分三段验的，每段验的是**不同的真东西**：

| 段 | 验什么 | 怎么做的 |
|---|---|---|
| A | **采集器在真 DOM 上跑** | 起本地 http server（**两个端口** = 同源 + 跨域 iframe），真 Edge 打开测试页，通过 CDP 在那页上**真执行 `collectPageContext`** |
| B | 侧边栏按钮接线 | 真扩展 + 侧边栏，真点「观察页面」，状态行要出**结果态**人话 |
| C | 完整链路落盘 | 真源码树 Harbor + 真 host（`runHost` 喂**扩展形状**的帧）→ 验会话文件里有渲染后的 markdown |

**关键判据的实测值**：

| 判据 | 实测 |
|---|---|
| 选区 + 所在元素引用 | `text=这是用来做选区的一段文字。 ref=60684574.s7` |
| 元素列表 | 6 条；按钮 `role=button`、禁用 `disabled=true`、勾选框 `checked=true` |
| **密码遮蔽** | `masked=true` 且**整个返回值里不含 `secret123`** |
| 跨域 iframe | `accessible=false` + `跨域（浏览器不允许读它的内容）`；**无任何内容字段** |
| 同源 iframe | `accessible=true` |
| **版本号稳定** | 同页面两次 = `60684574` vs `60684574`（相同 ✓） |
| **版本号会变** | 改 DOM 后 = `60684574 → c4d13c51`（变了 ✓） |
| ref 形态 | 每条都以当前版本号开头（`60684574.1`） |
| 预算 | `maxItems=2` → 2 条 + `truncated=true` |
| 落盘 | 会话文件里有渲染后的观察结果（含 `cafe1234.e1`）、**过防注入包装**、跨域「读不到」也在 |

**回归**：`accept-phase2` 18/18 · `3a` 16/16 · `3b` 15/15 · `3c` 20/20 —— **零回归**。
自检 **4785/0**（新增 159 组 41 条）· `npm run verify` 全绿。

### 8.1 过程中踩到并修掉的两个坑（都记进注释了）

1. **★ 采集器必须自包含** —— `executeScript({ func })` 会把它 `toString()` **序列化**后注入。
   函数体里引用任何**模块级**常量 / 导入 → 注入后 `ReferenceError`。而这**单测抓不到**
   （Node 里 require 时一切都在），**只有真机现形**。现在：常量写在函数体内、辅助函数嵌套
   在函数体内，且自检组 159 有一条断言扫「top-level 常量名有没有泄漏进函数体」。
   → 这条对 M04 同样成立（M04 的点击 / 填写也要注入），所以它是**这一阶段最该记住的一条**。

2. **验收脚本喂帧的形状** —— host 的 dispatcher 分派键是 `obj.type`（它面向**扩展发来的
   消息**），不是协议帧的 `kind`。第一版我喂了 `{v,id,kind,payload}` → host 回「只认 …」的
   兜底（`echo` 里能一眼看到原始帧）。喂 `{type:'observe-page', observation}` 才对。

### 8.2 遗留（都不是遗漏，是明确不做）

| # | 遗留 | 归属 |
|---|---|---|
| 1 | 阅读模式正文提取（标题层级 / 表格 / 图片 alt）—— 现在仍只有 `innerText` | 未排期 |
| 2 | SPA 的 DOM 更新观察 / 页面稳定判断 | **M04 的 `wait` 一起做** |
| 3 | iframe 内部**不递归采集**（只报告能不能读） | 需要时再加 |
| 4 | shadow 扫描有 3000 元素上限（超了 open 计数是**下界**，已如实标注） | 可接受 |
