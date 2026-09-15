# GPT「插件」的原理（研究）

> 2026-09-16 调研。来源见文末。抓取方式：服务端爬虫被 Cloudflare 拦，改用本机 Chrome
> 走 CDP 直连（`local-browser-fetch` 技能）。

## 一句话结论

**「插件」不是一种技术，是一个产品**。它两次实现用的是完全不同的机制：

- **第一代（2023–2024，已下线）**：`ai-plugin.json` 清单 + OpenAPI 规格 → 平台把
  「HTTP 接口」**自动转成工具**。核心价值是**不用写服务端**。
- **现在（developers.openai.com，2026）**：插件 = 一个**包**，里面装 **skills +
  MCP server +（可选）UI +（可选）hooks**。核心变成了**MCP**。

⚠️ **对你这个项目最重要的两条**：
1. **MCP 那部分你已经有了**（stdio + 工具 + 隔离 + 审计），**skills 那部分你也有了**
   （`SKILL.md` + frontmatter，和 OpenAI 的 skills 几乎同构）。
   你缺的是另外三块 —— 见最后一节。
2. 你**只实现了 stdio transport**。而现在的插件生态里，MCP server 大多是**远程 URL**
   （HTTP/SSE）形式 —— 这是你现在接不上的最大一块。

---

## 一、第一代插件的原理（2023，已下线）

### ① 声明：一份清单放两个地方

```
https://你的域名/.well-known/ai-plugin.json     ← 清单（我是谁、怎么鉴权）
https://你的域名/openapi.json                    ← 接口规格（我有什么接口）
```

清单的字段（`schema_version: "v1"`）：

| 字段 | 作用 |
|---|---|
| `name_for_model` | 给模型看的机器名（小写、无空格） |
| `name_for_human` | 给人看的显示名 |
| **`description_for_model`** | **给模型看的「什么时候该用我」** —— 这是整套机制里最关键的提示面 |
| `description_for_human` | 给人看的一句话 |
| `auth` | 鉴权方式，四选一（见下） |
| `api` | `{ "type": "openapi", "url": "…" }` |
| `logo_url` / `contact_email` / `legal_info_url` | 展示与信任信息 |

鉴权四种：

| 类型 | 场景 |
|---|---|
| `none` | 公开只读 API |
| `service_http` | 服务级 key（**所有用户共用一个**，插件作者填） |
| `user_http` | 用户级 key（**每个用户自己填**，比如他自己的 GitHub token） |
| `oauth` | 完整的 OAuth 授权流程 |

### ② 转换：OpenAPI 的每个 operation → 一个「工具」

ChatGPT 拉下 OpenAPI 文档，把里面每个 `operation`（`GET /todos`、`POST /todos`）
**自动变成一个模型能调用的工具**：

```
operationId      → 工具名
summary/description → 工具描述（模型靠它决定什么时候用）
parameters/requestBody → 参数的 JSON Schema
```

**这一步是整套机制的核心**：你写的是给人看的 REST 文档，
平台把它翻译成「模型看得懂的能力清单」。**你不用为模型写任何东西**。

### ③④⑤ 调用循环

```
用户提问
  → 模型看到工具清单，决定「调 list_todos，参数 {done: false}」
  → ★ 平台（ChatGPT 后端）代模型发 HTTP 请求，自动带上鉴权
  → 响应文本塞回对话
  → 模型接着回答（或再调一次）
```

### 四个要害（现在做同类设计也绕不开）

1. **模型永远不直接发请求。** 平台是唯一出口 —— 这也意味着
   **权限、审计、限流只能做在平台这一层**，做在「描述里叮嘱模型」是没用的。
2. **描述文本就是提示词。** `description_for_model` 写得好不好，直接决定
   模型「想不想得起来用你」。这和工具描述是同一个道理。
3. **鉴权由平台保管。** 用户授权 → 平台存 token → 调用时自动填。
   插件本身拿不到用户的凭据（至少协议设计上是这样）。
4. **返回内容是不可信数据。** 插件返回的文本会进模型上下文 ——
   **注入是这一代最大的安全问题**（和我们处理 MCP / 网页返回值是同一类风险）。

### 现状

**ChatGPT Plugins 在 2024 年被 OpenAI 下线。**
`ai-plugin.json` 这个约定本身还活着 —— 被 Custom GPTs 的 Actions、
LibreChat 以及一些开源 agent 框架继续沿用，但官方定位已经变成
「给老客户端用的兼容面」。

---

## 二、现在的「插件」（2026）

### 插件 = 一个包

```
Plugin
├── Skills                    （SKILL.md + 脚本/参考/模板）
└── MCP server（可选）
    ├── Tools and structured results
    └── UI resources（可选）
```

清单文件：根目录 `plugin.json`（Agent Plugins schema），
或 `.codex-plugin/plugin.json`（Codex 兼容布局，老的）。
目录里可以有 `skills/`、`mcp.json`、`assets/`、`hooks/`。

### 四种形态（官方给的选型表）

| 形态 | 什么时候选 |
|---|---|
| 只要 skills | 指令 + 模型已有的工具就够 |
| 只要 MCP server | 需要接外部系统，不需要额外的工作流说明 |
| skills + MCP | skills 负责「怎么做」，MCP 负责「能碰到什么」 |
| MCP + UI | 需要**看/比/改/确认**结构化信息时才加界面 |

### 关键设计取向（值得抄）

- **UI 不是必需的**，而且「**工具本身要在没有 UI 时也有用**」
  （否则 headless 场景直接废掉）
- UI 走开放的 **MCP Apps UI 标准**，ChatGPT 自己的扩展是**可选的增量**
- **ChatGPT 和 Codex 共用一个插件目录**，装一次两边可见
- hooks（在运行时某些点跑命令）**有额外的信任要求**，
  「在网页上安装插件」**不会**把脚本部署过去

---

## 三、MCP 和插件是什么关系

**MCP 把第一代插件的机制「协议化」了**：

| 第一代插件 | MCP |
|---|---|
| `ai-plugin.json` 清单 | `initialize` 握手（客户端自己声明能力） |
| OpenAPI 文档 | `tools/list`（**运行时**拉，不是静态文档） |
| 平台代发 HTTP | `tools/call`（JSON-RPC） |
| HTTP 轮询/请求 | stdio / HTTP+SSE 传输 |
| 单向（模型调工具） | **双向**（server 可以主动请求采样、推通知） |

所以 **MCP ≈ 插件机制 + 协议标准化 + 双向通道**。
OpenAI 现在的插件就是用 MCP 实现的（skills 补上「工作流指令」这一层）。

---

## 四、对你这个项目意味着什么

### 你已经有的（不用做）

| 能力 | 你的实现 |
|---|---|
| 工具注册与调用 | `core/tools/registry.cjs` + `index.cjs`（参数校验/风险分级/审计） |
| MCP 客户端 | `core/mcp.cjs` + `mcp-connection.cjs`（连接池、环境隔离、超时） |
| **技能系统** | `core/skills.cjs` + `SKILL.md`（**和 OpenAI 的 skills 同构**） |
| 注入防护 | MCP/网页返回值都标注「这是数据不是指令」 |
| 密钥保管 | `credentials.cjs`（safeStorage） |

**结论：插件机制的两大件（skills + MCP）你都已经有了**，
而且安全模型比第一代插件时代做得还细（能力范围、风险分级、审计）。

### 你缺的三块（按我的推荐排序）

#### ① 远程 MCP（HTTP transport）—— 建议先做

你现在 `mcp-connection.cjs` 只有 `spawn`（stdio）。
**现在的插件生态里，MCP server 大多是远程 URL 形式**（带 OAuth 或 API key）。
不做这个，等于接不上现成的插件生态。

工作量：中。要动的是「传输层抽象」——把现在写死的 spawn + stdin/stdout
抽成 `transport` 接口，再加一个 HTTP/SSE 实现。
已有的连接池、工具合并、隔离、审计都能复用。

#### ② 插件包（一个包绑 skills + MCP）—— 体验层，工作量小

你现在是**两处分别配**（设置 → 扩展里加 MCP；技能在另一个地方管）。
按官方那种「一个包装两样」，用户导入一个文件夹就能带走一套能力。

顺带能解决一个现实问题：**技能和 MCP 是配套的**（技能里写的步骤要调某个 MCP 工具），
分开配容易配错版本。

#### ③ 「HTTP API → 工具」的清单式接入 —— 有吸引力但**安全面大，要谨慎**

这就是**第一代插件那套的价值**：用户不用写 server，
指向一个已有的 REST API（+ OpenAPI 或一个简化清单），app 把 operation 转成工具。

**为什么有价值**：门槛低。写 MCP server 是开发者干的活，
而「我有一个 API key，想让你能查这个服务」是普通用户的需求。

**为什么危险**（三个都得处理，不能只处理一个）：
- **SSRF**：用户填的 URL 会被主进程请求 —— 内网地址、云元数据端点
  （`169.254.169.254`）都得拦
- **密钥**：清单里可能有 key → 必须走 `credentials.cjs`，
  绝不能落进 `config.json`（这条你已经踩过、有 `redact.cjs` 的基础设施）
- **注入**：REST 返回的文本直接进上下文 —— 和网页一样是最脏的来源，
  必须走「标注为数据」那套

**如果做，我的建议是**：只支持**用户显式导入的清单**（不做自动发现
`/.well-known/`）、域名白名单 + 首次调用时确认、只支持
`GET`/只读（写操作单独批）。

#### ④ UI resources —— 不建议现在做

MCP Apps UI 标准 + 沙箱渲染 + 自己的组件协议，
对「一个人维护的工具」来说投入产出比太低。官方自己也说
「工具本身要在没有 UI 时也有用」。

---

## 五、我建议的路线

1. **远程 MCP（HTTP/SSE transport）** —— 一次做完就能接上整个生态，
   而且你的架构已经铺好了，是增量不是重写
2. **插件包（skills + MCP 打成一个文件夹，导入即用）** —— 小改动，体验提升明显
3. **之后再评估**「HTTP API 清单式接入」—— 它的价值很实在，但安全面
   要单独一轮认真做（SSRF + 密钥 + 注入），不能顺手加

---

## 来源

| 内容 | 来源 | 抓取时间 |
|---|---|---|
| 现在的插件架构（skills / MCP / UI / hooks、四种形态、选型表） | `https://developers.openai.com/plugins/concepts/plugins.md` | 2026-09-16 |
| 打包与清单（`plugin.json`、`.codex-plugin/plugin.json`、目录结构） | `https://developers.openai.com/plugins/build/plugins` | 2026-09-16 |
| `ai-plugin.json` 清单规范（字段表、四种鉴权、**「ChatGPT Plugins 2024 年下线」**） | `https://geodocs.dev/technical/well-known-ai-plugin-manifest-spec`（2026-05 更新） | 2026-09-16 |
| 官方文档索引 | `https://developers.openai.com/plugins/llms.txt` | 2026-09-16 |

**待核**：
- 第一代插件的调用细节（平台代发 HTTP、鉴权代填）来自对其规范的理解和多方转述，
  **OpenAI 的原始文档现在打不开**（`platform.openai.com` 对我这边返回 403），
  没能逐字核对。
- `geodocs.dev` 是第三方文档站，不是 OpenAI 官方 —— 它的「2024 年下线」这个说法
  我标注为**待核**（方向应该对：官方现在只讲 plugins/Apps SDK，不再讲 ChatGPT Plugins）。
