# Harbor 全场景自我纠错、ID 关联与审批档位实施蓝图

> **回迁说明（2026-11-06）**：原文件在仓库外
> `C:\Users\<user>\Documents\Codex\2026-10-29\e-codexworkbench\outputs\`，
> 资料整理第一批移入本仓库，**原件保留在原处**。
> **状态：设计蓝图（未核实施工进度）**。原文自述「不表示功能已经实现或通过测试」，
> 本轮回迁只做了搬运核对，**没有逐条核实哪些阶段已落地** ——
> 拿它当依据前先在代码里确认，别把它当现行规范。

日期：2026-11-02  
用途：交给 Harbor Agent 分阶段实施。本文是**设计和验收依据**，不表示功能已经实现或通过测试。  
源码位置：`E:\CodexWorkbench`；自举开发版：`E:\Harbor-Dev`；便携版：`E:\Harbor`。三个位置的 `data/` 独立，不得互相覆盖。

## 1. 产品目标

Harbor 是**全场景通用 Agent**。自我纠错要覆盖网页研究、文件整理、日常事务、代码工作和以后新增的领域。它要做到：

1. 执行中发现“预期与实际不一致”，立即止损、换方法或在确实需要人时暂停。
2. 后台保存原始证据，并整理成**待验证经验**；一次失败不能直接变成真理。
3. 下次按任务、对象和错误特征检索少量相关经验，避免把全部历史塞进每轮提示。
4. 不让模型自行宣布操作成功、批准自己的经验，或改写可信验证器。
5. 日常纠错尽量安静；必须由人处理的身份、授权、不可逆或高风险事项仍停下。

对使用者的承诺：档位减少无意义的确认，**不会**把“激进”解释成“任何事情都可自动做”。

## 2. 术语和边界

| 名称 | 含义 | 不能混同 |
| --- | --- | --- |
| 错误事件 `errorFeature` | 一次实际观察到的偏差及证据 | 不是已证实的原因或修法 |
| 经验 `experience` | 对一类情形的原因假设、可行做法和适用边界 | 不是原始事件 |
| 验证器 `validator` | 独立检查操作结果的规则或程序 | 不能由被检查的 Agent 自批自用 |
| 对话 `sessionId` | 一段持续对话 | 不等于其中所有任务 |
| 任务 `taskId` | 当前目标 | 不一定有项目或本地目录 |
| 工作区 `workspaceId` | 当前操作的目录 | 不等于用户建立的项目 |
| 资源 `resourceId` | 网页、文件、文档、账户等具体对象 | 不一定有文件路径 |
| 项目 `projectId` | 用户组织工作的可选容器 | 不得由“有目录”强行推定为通用概念 |

## 3. 已核对的源码现状与关键反证

下面是 2026-11-02 对 `E:\CodexWorkbench` 的静态源码盘点；真机表现仍须验收。

| 事项 | 现状 | 实施时要解决 |
| --- | --- | --- |
| 工具失败 | `electron/core/tool-runner.cjs` 发 `agent.tool.failed`，有 `ok/result`，部分失败带 `errorKind/errorHint`；没有统一 `error` 对象；`src/types/chat-events.ts` 未声明后两项 | 建立统一失败事实及来源，确保前端、任务、磁盘不丢字段 |
| 误判成功 | `electron/core/tools/run_project_test.cjs` 已用 `toolOk` 纠正测试假绿；普通 `run_shell.cjs` 的非零退出码仍主要留在文本中，需实测其活动记录 | 退出码、超时、断言必须成为独立字段，不能靠文字前缀猜 |
| 重复失败 | `electron/core/loop-guard.cjs` 看工具名和参数重复，**不看失败结果**；`failure-streak.cjs` 连续失败两次会提醒换方案，但不是硬熔断 | 共用事实与尝试预算；区分“重试”“换方案”“停止” |
| 记忆 | `memory-store.cjs` 已有 `scope/projectId/sessionId`；`memory-recall.cjs` 可按范围筛选 | 增加经验状态、证据、可信来源及结构化匹配；普通记忆不等于已验证经验 |
| 项目记忆 | `tools/remember.cjs` 传 `sessionId`，未传 `projectId`；`loop-tool-context.cjs` 未把 `projectId` 给 `memory_search` | 写入、自动注入和主动检索必须使用同一份身份上下文 |
| 对话与项目 | `session-write.cjs` 创建 `sess_` 并写入目录、项目 ID；更新工作目录时没有同步更新项目 ID | 统一归属解析，禁止界面、会话、任务各自推断 |
| 任务 | `task-create.cjs` 保存 `sessionId/projectId/workdir`；`task-io.cjs` 保存独立 `task_*.json` | 新关系先用外挂表，保留旧任务文件 |
| 配置 | `config.cjs` 可原子写 `data/config.json`；`config-normalize.cjs` 会规范化字段 | 新字段必须同时加默认值、规范化、前端类型，否则保存后可能消失 |
| 写入闸 | `tools/pre-write-gate.cjs` 只处理 `write_file/edit_file` 的覆盖澄清与“改过文件但无计划” | 档位不能误称控制所有写入，更不能替代风险判断 |
| 风险策略 | `risk.cjs` 当前允许策略把 `high/critical` 设为 `allow`；`full` 权限可不弹窗 | 若要承诺“高危永远保留”，必须建立独立的最低保护线，不能只改 UI |
| 人工卡片 | `ask_user({gate:true})` 要明确点“执行”；`AboveInputCards.tsx` 协调 `PermissionBar` 与澄清卡 | 新档位不得吞掉必须由人处理的请求 |

**特别注意：**`memory-store.cjs` 当前对内容完全相同的记忆直接去重，未先比较作用域或归属。新经验不能沿用这种跨范围去重方式。

## 4. 错误事件：跨领域的统一事实格式

建议新增版本化事件。缺失字段保留 `null`，不能让模型补造“看起来合理”的值。原始事实与原因假设分开；所有落盘文本先过现有脱敏层。

```json
{
  "schemaVersion": 1,
  "id": "err_...",
  "occurredAt": "ISO-8601",
  "identity": {
    "sessionId": "sess_...",
    "taskId": "task_...",
    "projectId": null,
    "workspaceIds": [],
    "resourceIds": []
  },
  "domain": "web",
  "category": "assertion_failed",
  "operation": {
    "intent": "打开目标网站",
    "action": "click",
    "targetType": "page_element",
    "targetFingerprint": "role=link;name=官方网站"
  },
  "expectation": { "condition": "进入目标网址", "source": "user_request" },
  "observation": {
    "outcome": "failed",
    "reasonCode": "ELEMENT_NOT_FOUND",
    "exitCode": null,
    "systemCode": null,
    "actualState": "页面中没有该链接"
  },
  "context": { "phase": "查找资料", "app": "Edge", "origin": "https://example.com" },
  "evidenceRefs": ["证据记录的 ID"],
  "observedBy": "browser_observer",
  "causeHypotheses": []
}
```

`domain` 建议初期支持 `code/web/file/research/daily/other`；`category` 至少支持 `tool_failure/assertion_failed/external_blocked/claim_disputed/user_correction`。分类是索引，不能假装解释了原因。`exitCode`（进程退出码）与 `systemCode`（如 `ENOENT`）必须分开。

| 例子 | 事实来源 | 至少要保留的证据 |
| --- | --- | --- |
| 网页元素没找到 | 浏览器工具/观察器 | 页面来源、目标特征、当时页面快照 |
| 文件被占用 | 文件工具/操作系统 | 操作、源目标、系统错误码、当时文件状态 |
| 查错数据或模型幻觉 | 来源核查器、用户纠正 | 原陈述、所用来源、核查结果与来源时间 |
| 用户说“不对” | 用户消息 | 原话、被否定的具体陈述或操作；指向不明就保持未关联 |

**生成责任：**工具和观察器写不可改写的原始结果；协调层规范化并落盘 `errorFeature`；模型只能提出原因假设与修法候选。模型不得把自己的解释写回原始观察字段。

## 5. 经验生命周期与匹配

### 5.1 状态机

```text
原始错误事件 → candidate → verified → deprecated
                     ↓             ↓
                  rejected      suspended
```

| 状态 | 允许做什么 | 转换条件 |
| --- | --- | --- |
| `candidate` | 后台比对和积累复现，不能作为必须遵守的规则 | 至少有错误证据、原因假设、适用边界和修法候选 |
| `verified` | 匹配时按需注入，受用户指令和更高权威规则约束 | 可信验证器或独立观察证明修法有效；按风险与档位满足批准条件 |
| `suspended` | 停止注入，保留调查记录 | 出现有力反例、证据矛盾、验证器版本失效 |
| `deprecated` | 历史可查，不再注入 | 环境变化、被新版经验替代 |
| `rejected` | 历史可查，不再建议相同假结论 | 原因判断错、修法无效或证据不成立 |

**复现 N 次只能证明问题反复出现，不能自动证明某个修法正确。**“独立验证”须是不同执行机会、独立证据来源；同一次调用的重试、同一份截图重复入库、模型口头声称成功都不计数。建议的激进档阈值为 **3 次独立成功验证**，仅用于低风险建议，不用于强制规则。高风险经验和验证器注册始终需要人类批准。

经验记录应有 `scope`、`authority`、`risk`、`triggerFeature`、`causeHypothesis`、`recommendedAction`、`evidenceRefs`、`validatorId/version`、复现与独立验证计数、状态变化历史。`global/project/session` 是**适用范围**，不是**权威等级**。当前明确的用户要求、经批准的强制规则、普通偏好、模型总结必须分层裁决；冲突不明时不能静默选择。

### 5.2 混合检索

不能用 `domain + category` 做跨领域硬过滤。检索分两步：

1. 并行找候选：结构字段（操作、对象、错误码、阶段）、意图语义、已知原因关系。`domain/category` 提高排序，但允许跨领域候选。
2. 核对证据链：预期、实际观察、被纠正的陈述及来源是否指向同一原因。模型可提出“疑似同源”，不得直接合并。

缺字段时降级：有对象和证据则做部分匹配；只有“不对”则先找到它否定的具体输出；仅有模糊文字则只供后台分析，不自动触发操作性规则。每次匹配要能说明“为什么命中”，并记录实际是否帮助避免旧错。

## 6. 五层 ID 与外挂关联表

**不以 `workspaceId` 取代 `projectId`。**项目是可选组织容器，工作区是操作目录。`pending_` 只是前端占位，第一次发送后转 `sess_`；长期关联只使用正式 `sess_`。一条对话可有多个 `task_`，一项任务可涉及零个或多个工作区与资源。

第一阶段可在 `data/` 建版本化关联存储，保留原会话、任务和记忆文件。例如：

```json
{
  "version": 1,
  "sessions": {
    "sess_abc": {
      "projectId": null,
      "workspaceIds": ["ws_123"],
      "source": "legacy_workdir",
      "confidence": "inferred"
    }
  },
  "tasks": {
    "task_xyz": {
      "sessionId": "sess_abc",
      "workspaceIds": ["ws_123"],
      "resourceIds": ["res_456"]
    }
  }
}
```

`data/associations.json` 只是示例；大量并发更新时可拆分文件或使用追加日志。必须有**唯一关联解析入口**供新任务、记忆写入、自动注入、`memory_search`、工作目录切换共同使用；只创建表而不接入读写链路没有作用。写入应原子化，保留来源、时间和版本，能检测悬空 ID。

### 旧数据默认归属

| 旧记录 | 迁移规则 |
| --- | --- |
| 明确带 `sess_` | 保留该对话归属 |
| 带 `workdir` | 可推断一个 `workspaceId`，标 `inferred`；不得因此自动创造用户项目 |
| 明确带 `projectId` | 保留原项目 ID，不自动换成工作区 ID |
| 项目记忆的 `projectId` 为空 | 标“归属待确认”，不升级为全局，不向其他项目注入 |
| 无目录、项目和资源 | 未知关联留空；保留原本可确认的作用域 |
| `pending_` | 不进长期关联表；正式会话创建后再绑定 |

切换工作目录时，**对话记忆跟随 `sess_`；旧项目记忆仍属旧项目；全局记忆不变**。会话、任务和关联表必须对同一新目录得出同一个结论。跨项目复制经验需单独判定，不能由目录切换自动完成。

## 7. 对话框审批档位

在输入区工具/模式选择附近增加“保守 / 标准 / 激进”切换器。`assistant.approvalLevel` 存在 `data/config.json` 作为全局默认；当前对话可保存覆盖值。旧对话无覆盖值时用全局默认，旧配置无此字段时用 `standard`。每轮开始时固定生效档位并记审计；运行中切换只影响下一轮。

**档位控制确认频率，不授予工具权限。**现有只读权限、本轮禁止写入、用户明确要求等待、路径和网络边界仍生效。以下矩阵是**目标行为**，不是已实现现状：

| 行为 | 保守 | 标准 | 激进 |
| --- | --- | --- | --- |
| 只读查询、普通网页研究 | 执行并记录 | 执行并记录 | 执行并记录 |
| 低风险、可恢复的新建或修改 | 先确认 | 按现有权限/风险策略 | 权限允许时免普通确认，留审计与恢复点 |
| 覆盖已有文件 | 逐次确认并展示差异 | 保留覆盖澄清和现有确认 | 可免普通覆盖澄清；仍受硬边界约束并留恢复点 |
| 多步文件工作缺计划 | 要求先明确计划 | 保留现有计划闸 | 普通小范围操作可放行，记录目标与步骤 |
| 中风险命令 | 逐次确认 | 按现有策略及短时同类授权 | 策略允许时可免普通确认，留审计 |
| 高风险命令、整目录删除、大范围不可恢复操作 | 独立确认或拦截 | 独立确认或拦截 | **仍独立确认或拦截** |
| `critical` 危险命令 | 拦截 | 拦截 | 拦截 |
| 验证码、登录、付款、法律承诺、用户指定“等我确认” | 暂停等人 | 暂停等人 | 暂停等人 |
| 低风险经验从 `candidate` 升为 `verified` | 人工批准 | 独立验证后按类别处理，默认需批准 | 3 次独立成功验证后可静默升级为**建议** |
| 高风险经验或可信验证器注册 | 人工批准 | 人工批准 | 人工批准 |

当前 `risk.cjs` 能让配置放行 `high/critical`；若要实现表中“任何档位都保留高危保护”，必须先明确新的最低保护线并做真机验收，不能仅改切换器文案。与现有 `tools.permission=full` 的语义冲突应在实施前明确展示给用户，不能静默改旧权限含义。

`ask_user({gate:true})` 和 `PermissionBar` 继续处理人工决定。验证码等状态要由浏览器观察标为 `requiresHumanAction`，暂停并保留现场；超时、跳过或模型猜测都不算用户完成。

## 8. 可信验证器

验证包括：网页是否真的跳转、文件是否真的到目标位置、引用是否支持结论、外部事务是否出现最终状态。验证器可为声明式规则或受控程序，存放在**与模型可写经验目录分离**的可信注册表。每项要有 ID、适用操作、版本、内容摘要、批准者、允许读取的证据、可执行动作和失效条件。

模型可以提出候选验证方法，但不能登记、批准、替换或绕过可信验证器。运行前校验摘要；版本变动后失去批准状态。执行事实由系统记录，模型口头“已通过”不算。若现有核心没有可信加载入口，必须新增一个最小的验证器注册与执行入口；单靠 Markdown 声明或提示词无法形成信任边界。

## 9. 文件落点评估

以下路径以 `E:\CodexWorkbench` 为根。新增模块名称是建议，实施时按仓库结构和单文件 300 行限制拆分。

| 工作 | 现有文件/建议落点 |
| --- | --- |
| 输入区切换器 | `src/components/chat/Composer.tsx`；建议独立 `ApprovalLevelPicker.tsx` |
| 前端配置类型与保存 | `src/types/models.ts`、`src/stores/useConfigStore.ts` |
| 配置默认、校验与落盘 | `electron/core/config-defaults.cjs`、`config-normalize.cjs`、`config.cjs` |
| 对话级覆盖与首发迁移 | `src/stores/app/threadFolders.ts`、`src/stores/useThreadStore.ts`、`electron/core/session-write.cjs` |
| 本轮档位、身份上下文 | `electron/handlers/chat.cjs`、`electron/core/loop-tool-context.cjs`、消息载荷构造路径 |
| 写入、路径与命令风险 | `electron/core/tools/pre-write-gate.cjs`、`tools/index.cjs`、`tools/permission.cjs`、`tools/risk-gate.cjs`、`risk.cjs` |
| 人工卡片 | `src/components/chat/AboveInputCards.tsx`、`PermissionBar.tsx`、`electron/core/tools/ask_user.cjs` |
| 原始错误及分类 | `electron/core/tool-runner.cjs`、`errors.cjs`、`error-observer.cjs`、`src/types/chat-events.ts`、`src/stores/thread/streamEvents.ts`、`src/lib/schemas.ts` |
| 记忆范围与检索 | `electron/core/memory-store.cjs`、`memory-scope.cjs`、`memory-recall.cjs`、`tools/remember.cjs`、`tools/memory_search.cjs` |
| 身份关系与迁移 | `electron/core/session-write.cjs`、`session-read.cjs`、`task-create.cjs`、`task-io.cjs`；建议新建关联解析模块及版本化数据存储 |
| 可信验证器 | 建议独立注册表、执行器、审计模块；不要混入普通技能目录 |

## 10. 分阶段实施与验收

### 阶段 A：事实和身份基础

统一工具失败事实，新增 `errorFeature`，保证退出码、超时、断言、用户纠正都有可追溯证据。建立只读关联解析器，核对旧 `sess_/task_/projectId/workdir`，修复目录切换后的归属分歧。**验收：**失败不会显示成功；旧数据不被批量重写；未知归属不会扩大为全局；切换目录、重开对话后身份一致。

### 阶段 B：档位与硬边界

新增全局默认和对话级覆盖、输入区切换器、本轮快照及审计；先建立高危最低保护线，再调整普通确认。**验收：**三个档位逐项跑矩阵；切档不会改写已运行中的决定；激进档下 `critical` 仍拦截，必须人工处理的验证码仍暂停；现有 `ask_user`、`PermissionBar` 不丢请求。

### 阶段 C：经验和可信验证

加入经验状态机、混合匹配、独立验证计数、可信验证器注册。**验收：**重复三次失败不会自动变成正确规则；激进档只有低风险、经三次独立成功验证的建议可静默升级；高风险经验仍须人批；验证器被改动后旧批准失效；跨领域候选能提出关联但证据不足不自动合并。

### 阶段 D：人话呈现与回归

用户默认只看到“做成了吗、遇到什么问题、是否需要我做事”。后台经验、匹配解释和审计在详情中可查。用真实网页、文件、资料纠正及编码任务分别验收；测试环境与真实 `data/` 隔离，并使用统一测试工具记录回归证据。

## 11. 给 Harbor Agent 的执行规则

这是一份跨阶段蓝图，**不要一轮改完整套系统**。每阶段开工先列出本次具体目标、允许改的文件和可观察验收结果，遵守源码仓库 `AGENT.md`；完成一个可验收切片再进入下一个。所有新增落盘数据必须放在本版本的 `data/` 下、经过脱敏、可迁移、可恢复。不得以模型文字、一次重试或旧测试结果宣称自我纠错已经有效。
