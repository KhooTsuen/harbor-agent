# Artifact（成果）系统 —— 方案

> 2026-09-23 立项。**先出方案，没开工。**
> 来源：复核 `docs/改造任务/PROGRESS.md` 时发现「Artifact 只到一半」——
> 面板有了、从回答里抽代码块有了，但**内核侧一行代码都没有**。
>
> | 批次 | 状态 |
> |---|---|
> | 1. 内核落盘 + 版本化 + IPC | ⬜ 待做（本文档） |
> | 2. 面板接真实数据（列表 / 版本切换 / 打开文件） | ⬜ 待做 |
> | 3. 与 changeSet 的边界收口 | ⬜ 待做 |

---

## 一、现状（照着代码核过，不是印象）

| 东西 | 位置 | 实际状态 |
|---|---|---|
| 渲染层的成果类型 | `src/types/index.ts` 的 `Artifact` | 有：`id / type / name / path? / taskId? / sourceMessageId / createdAt` —— **没有 `content`、没有 `version`** |
| 从回答里抽代码块 | `src/stores/thread/parseToolOutput.ts` 的 `extractArtifacts()` | 能用。正则抓 ``` 围栏里的**文件名**，只记元信息（注释里明写「**只记元信息，不动真实文件**」）—— **代码内容本身没存** |
| 取回（含版本） | `src/types/models-extra.ts` 的 `ArtifactRecord` / `ArtifactListResult` | ⚠️ **全仓无人使用**（`grep` 只命中定义处）—— 这是当初给内核侧**预留的形状**：`version` / `content?` / `updatedAt` / `versions[]` |
| 面板 | `src/components/chat/ArtifactsPanel.tsx` | 只是把各会话消息里的 `artifacts` 汇总去重后列出来（**纯前端内存**） |
| 内核侧 | `electron/` | **完全没有 artifact 模块**：没有 `core/artifact*.cjs`、没有 handler、没有 IPC 通道 |
| 落盘 | `data/` | 没有 `artifacts/` 目录 |

**一句话**：现在这个「成果」面板是**只读的会话副产品**——关掉会话就没了，
点开也只能跳到那个文件（`fsReveal`），看不到「它有几版、每版长什么样」。

---

## 二、为什么值得做

现在的行为有个真实缺口：模型在回答里给出一个文件的内容（比如一份 `install.sh`），
面板上会显示一条「成果 · install.sh」—— **点进去只有路径，内容没了**。
用户想「拿这份内容」只能回聊天记录里翻那条消息、再手动复制。

而且它跟已有的东西**对不上**：

- 会话有历史（`versions` / `versionIndex`）
- 任务有台账 + 检查点
- 磁盘改动有事务（`changesets`，可整批回滚）

**只有「成果」没有历史** —— 模型把同一个文件改了三版，你只能看到最后一版。

---

## 三、设计

### 3.1 两种来源，必须分开对待

这是整个设计里最关键的一条 —— 现在 `Artifact.type` 混着两种东西：

| 来源 | 例子 | 有没有真实文件 | 建议 type |
|---|---|---|---|
| **回答里的代码块**（`extractArtifacts` 抽的） | 模型在回答里贴了一段 `docker-compose.yml` | ❌ 只是个字符串 | `code` / `document` |
| **模型真写进磁盘的文件**（`write_file` / `edit_file` 动的） | `E:\proj\src\a.ts` 真的被改了 | ✅ 有 `path` | `generated_file` / `patch` |

**为什么要分**：前者回滚要走「成果自己的版本历史」，后者回滚**已经有 `changesets` 了**
（`electron/core/changeset.cjs`）—— 别重复造一套。见 3.4。

### 3.2 存储：`data/artifacts/<id>/`

跟 `changesets` 一样的形态（一个成果一个目录，人能直接进去看）：

```
data/artifacts/<artifactId>/
  meta.json     ← 元信息 + 版本清单（不含正文）
  v1.md         ← 第 1 版的正文
  v2.md
  ...
```

`meta.json` 用 `ArtifactRecord` 的形状（**那个预留类型终于用上了**），但正文外置：

```jsonc
{
  "schemaVersion": 1,
  "id": "art_mucw...",
  "type": "code",
  "name": "install.sh",
  "path": "scripts/install.sh",     // 可能没有（纯代码块）
  "threadId": "...", "taskId": "...", "sourceMessageId": "...",
  "createdAt": 1758600000000,
  "updatedAt": 1758600100000,
  "latest": 2,
  "versions": [
    { "version": 1, "bytes": 812, "createdAt": 1758600000000 },
    { "version": 2, "bytes": 946, "createdAt": 1758600100000 }
  ]
}
```

**为什么正文外置**（不像 `ArtifactRecord` 那样内联 `content`）：一份报告可能几十 KB，
塞进 `meta.json` 的话，列个清单就要把所有历史正文都读进内存 —— 和会话列表
「只读第一行」是一个道理（见 `session-read.cjs` 的 `list()`）。

**上限**：`maxVersions = 50`，超了丢最旧的（和 `backup.cjs` 的 `KEEP = 10`、
日志 6MB 轮转一个思路）—— 成果不能把磁盘吃光。

### 3.3 版本化：append-only

跟会话文件同一个思路：**每变一次追加一版，不原地改**。
判断「变了」用内容比较（和 `parseToolOutput` 现在按代码块逐条走一个道理）。

- 同一 `(name, path)` 的成果视为**同一个成果的新版本**，不是新成果
- 内容没变 → **不新增版本**（免得模型重复贴同一段就多一版）
- 删成果 = 删目录（`sessionCore.remove` 就是这么干的）

### 3.4 和 `changeset` 的边界（别重复造）

| 问题 | 谁答 |
|---|---|
| 「模型改了磁盘上哪些文件、怎么整批撤」 | `changeset.cjs`（**已有**） |
| 「这份成果长什么样、改过几版」 | artifact（本文档） |
| 「把成果恢复成某一版」 | 有真实 `path` → 走 changeset 的写入路径（复用 `snapshotBefore`）；纯代码块 → 写文件要**用户确认**（算写操作） |

★ **不要**给 artifact 做 diff / 合并 —— 那两种能力分别属于 `diff-text.cjs` 和 git，
成果只管「存 + 看 + 取回」。

### 3.5 IPC 通道（★ 不同步 `ipc-channels.cjs` 自检会报 `channelsMissing`）

形状直接用预留的 `ArtifactListResult`：

| 通道 | 参数 | 返回 |
|---|---|---|
| `artifacts:list` | `(threadId?)` | `ArtifactListResult`（**不含正文**，只给清单） |
| `artifacts:get` | `(id, version?)` | `{ ok, artifact, content }` |
| `artifacts:save` | `(draft)` | `{ ok, artifact }` —— 从回答里「存为成果」 |
| `artifacts:remove` | `(id)` | `{ ok }` |
| `artifacts:reveal` | `(id)` | 在文件管理器里打开它的目录 |

全走已有的 `wrapInvokeHandlers()` 兜底（成败自动进主日志 + 动作流水），不用额外埋点。

### 3.6 自动还是手动落盘？（要你拍板，见第五节）

现状 `extractArtifacts` 是**全自动**的 —— 模型每贴一个带文件名的代码块就多一条成果。
如果落盘也全自动：一天下来 `data/artifacts/` 会有几百个目录，绝大多数没人看。

---

## 四、要改的地方

| 位置 | 改什么 |
|---|---|
| `electron/core/artifact-store.cjs`（新） | 读写 `data/artifacts/`：`list` / `get` / `save` / `remove`；目录在 `paths.cjs` 里加一个 `DIRS.artifacts` |
| `electron/core/artifact-versions.cjs`（新） | 版本追加 + 上限裁剪（拆开，免得单文件过 300 行） |
| `electron/handlers/artifacts.cjs`（新） | 5 个通道 |
| `electron/ipc-channels.cjs` | 加 5 个通道名（**漏了自检会红**） |
| `electron/preload.cjs` | 加 5 个方法（都走 `call()`，自动进动作流水） |
| `src/types/index.ts` | `Artifact` 加 `version?` / `latest?` |
| `src/stores/thread/parseToolOutput.ts` | `extractArtifacts` **要把代码块正文也带出来**（现在只抓了文件名） |
| `src/components/chat/ArtifactsPanel.tsx` | 从「汇总内存」改成读内核；加版本切换 + 打开文件 |
| `docs/安全模型.md` | 补一句：成果正文也过 `redact`（可能有密钥） |

---

## 五、要你拍板的四件事

1. **落盘触发方式**？
   - **A. 只手动**（回答里给「存为成果」按钮）—— 干净、可控，推荐
   - B. 全自动（现在的抽取逻辑直接落盘）—— 省事，但会堆垃圾
   - C. 折中：`write_file` / `edit_file` 真实改过的文件自动建成果，代码块只建元信息
2. **上限设多少**？（本节方案写 50 版 / 单版 ≤ 2MB，可调）
3. **纯代码块的成果要不要「一键写成文件」**？要的话走权限确认（算写操作）。
4. **要不要跟着会话一起删**？（现在删会话会清任务历史 —— 成果跟不跟？）

---

## 六、验收（做的时候照这个验）

1. **不联网单测**：写入 → 读出；同内容不新增版本；超 `maxVersions` 裁剪；越界版本号报错
2. **接线**：`--self-test` 的 `channelsOk` 仍为 `true`（加通道不改清单的经典坑）
3. **脱敏**：存一份含 `sk-xxxx` 的成果，回读确认已打码
4. **真机**：真跑一次 `npm run shot:electron`，看面板真的列出成果、版本能切（**测试全绿 ≠ 能用**，这条教训本项目吃过两次）
5. **迁移**：老会话里已有的 `artifacts` 元信息要不要导入？要的话写迁移，**保留旧数据**

---

## 七、明确不做

- **不做**成果的 diff / 三方合并 —— 那是 `diff-text.cjs` 和 git 的事
- **不做**「成果市场」/ 跨项目共享 / 云同步
- **不做**二进制成果（图片走 `image-watch.cjs`，那是另一条路）
- **不引**任何版本控制库（`zod` 足够校验，`node:fs` 足够存）

---

## 八、没验证的部分（如实说）

- `ArtifactRecord` / `ArtifactListResult` 是**当初预留的形状**，我没找到它出现在任何
  commit message 或文档里 —— 所以这里的设计是**按现状倒推的**，不是「还原当初的意图」
- 「一天会堆多少成果」是我的**推测**（按模型贴代码块的习惯估的），没有实测
