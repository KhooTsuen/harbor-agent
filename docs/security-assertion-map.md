# 84 项断言质量与生产路径映射

> 对应《安全测试有效性审计规范》Phase B。由 `security-effectiveness-results.json` 生成（数字会变，看那份）。
> 基线提交 `1c67a3d2b6201d09364306f3df5f86414617e7f4`。评级：STRONG / PARTIAL / WEAK / UNVERIFIED / N-A。

**分布：STRONG 73 · PARTIAL 10 · N/A 1 · WEAK 0 · UNVERIFIED 0**；P0 无 WEAK/UNVERIFIED。

| ID | 优先级 | 套件 | 生产入口（被测行为） | 测试文件 | 类型 | 评级 | 变异 | 说明 |
|---|---|---|---|---|---|---|---|---|
| SEC-001 | P0 | ipc | 原始 HTML 脚本执行隔离 | `scripts/security/suites/ipc.mjs` | renderer | 🟢 STRONG | — |  |
| SEC-002 | P0 | ipc | 图片错误事件 XSS | `scripts/security/suites/ipc.mjs` | renderer | 🟢 STRONG | MUT-01 |  |
| SEC-003 | P0 | ipc | iframe / srcdoc 隔离 | `scripts/security/suites/ipc.mjs` | renderer | 🟢 STRONG | MUT-02 |  |
| SEC-004 | P0 | ipc | Markdown/HTML 混合注入 | `scripts/security/suites/ipc.mjs` | renderer | 🟢 STRONG | — |  |
| SEC-005 | P0 | static | Electron WebPreferences | `scripts/security/suites/static.mjs` | unit/integration | 🟡 PARTIAL | — | 窗口 WebPreferences 是配置面，只能读 main.cjs 源码断言；运行期等价物归 SEC-080 |
| SEC-006 | P0 | static | preload 最小 API | `scripts/security/suites/static.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-007 | P0 | ipc | IPC sender 校验 | `scripts/security/suites/ipc.mjs` | unit/integration | 🟢 STRONG | MUT-03 |  |
| SEC-008 | P0 | static | IPC 参数校验 | `scripts/security/suites/static.mjs` | unit/integration | 🟢 STRONG | MUT-04 |  |
| SEC-009 | P0 | ipc | 外部链接与导航 | `scripts/security/suites/ipc.mjs` | unit/integration | 🟢 STRONG | MUT-05 |  |
| SEC-010 | P0 | static | CSP 与资源加载 | `scripts/security/suites/static.mjs` | unit/integration | 🟡 PARTIAL | — | CSP 写在 vite.config.ts，静态读源码；构建产物注入由 SEC-080 覆盖 |
| SEC-011 | P0 | ipc | 窗口关闭后权限失效 | `scripts/security/suites/ipc.mjs` | unit/integration | 🟢 STRONG | MUT-06 |  |
| SEC-012 | P0 | ipc | UI 与不可信内容隔离 | `scripts/security/suites/ipc.mjs` | renderer | 🟢 STRONG | MUT-02 |  |
| SEC-013 | P0 | agent | 网页间接提示注入 | `scripts/security/suites/agent.mjs` | unit/integration | 🟡 PARTIAL | MUT-07 | 确定性边界：断言网页正文被包成「数据非指令」，未调用模型证明模型不服从 |
| SEC-014 | P0 | agent | 文档间接提示注入 | `scripts/security/suites/agent.mjs` | unit/integration | 🟡 PARTIAL | — | 确定性边界：断言文档正文不提升为系统指令，未调用模型 |
| SEC-015 | P0 | agent | 工具输出伪造 | `scripts/security/suites/agent.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-016 | P0 | agent | 跨轮授权继承 | `scripts/security/suites/agent.mjs` | unit/integration | 🟢 STRONG | MUT-08 |  |
| SEC-017 | P0 | agent | 参数替换 TOCTOU | `scripts/security/suites/agent.mjs` | unit/integration | 🟢 STRONG | MUT-09 |  |
| SEC-018 | P0 | agent | 子 Agent 权限边界 | `scripts/security/suites/agent.mjs` | unit/integration | 🟢 STRONG | MUT-10 |  |
| SEC-019 | P0 | agent | 暂停/取消竞态 | `scripts/security/suites/agent.mjs` | unit/integration | 🟢 STRONG | MUT-11 |  |
| SEC-020 | P0 | agent | 工具调用预算 | `scripts/security/suites/agent.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-021 | P0 | agent | 不可信内容诱导泄密 | `scripts/security/suites/agent.mjs` | unit/integration | 🟢 STRONG | MUT-12 |  |
| SEC-022 | P0 | agent | 权限持久化污染 | `scripts/security/suites/agent.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-023 | P0 | agent | 计划与执行一致性 | `scripts/security/suites/agent.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-024 | P0 | agent | 危险操作失败闭合 | `scripts/security/suites/agent.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-025 | P0 | filesystem | 路径穿越 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | MUT-13 |  |
| SEC-026 | P0 | filesystem | Windows 路径边界 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | MUT-13 |  |
| SEC-027 | P0 | filesystem | 符号链接与 junction | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | MUT-14 |  |
| SEC-028 | P0 | filesystem | 路径竞态 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-029 | P0 | filesystem | Shell 注入 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | MUT-15 |  |
| SEC-030 | P0 | filesystem | 环境变量泄露 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-031 | P0 | filesystem | 删除/覆盖保护 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-032 | P1 | filesystem | 批量操作上限 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-033 | P1 | filesystem | 回滚完整性 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-034 | P1 | filesystem | ZIP Slip / 解压炸弹 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-035 | P1 | filesystem | 文件上传/附件解析 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-036 | P1 | filesystem | 临时文件权限 | `scripts/security/suites/filesystem.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-037 | P0 | browser | CDP 非授权标签 | `scripts/security/suites/browser.mjs` | unit/integration | 🟢 STRONG | MUT-16 |  |
| SEC-038 | P0 | browser | 导航后旧元素索引 | `scripts/security/suites/browser.mjs` | renderer | 🟢 STRONG | — |  |
| SEC-039 | P0 | browser | iframe / 弹窗越界 | `scripts/security/suites/browser.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-040 | P0 | browser | SSRF：回环/内网/元数据 | `scripts/security/suites/browser.mjs` | unit/integration | 🟡 PARTIAL | MUT-17 | IPv4 169.254.0.0/16 硬拒；IPv6 链路本地 / 域名型 / 其它厂商元数据 IP 在 allow 档未拒（见 limitations） |
| SEC-041 | P0 | browser | DNS 重绑定/重定向 | `scripts/security/suites/browser.mjs` | unit/integration | 🟢 STRONG | MUT-18 |  |
| SEC-042 | P1 | browser | CDP 断线/页面关闭竞态 | `scripts/security/suites/browser.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-043 | P1 | browser | 站点登录态与 cookie | `scripts/security/suites/browser.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-044 | P1 | browser | 浏览器下载入口与台账 | `scripts/security/suites/browser.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-045 | P1 | browser | 页面稳定等待超时 | `scripts/security/suites/browser.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-046 | P1 | browser | 网络失败与重试 | `scripts/security/suites/browser.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-047 | P1 | downloads | 服务端不支持 Range | `scripts/security/suites/downloads.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-048 | P1 | downloads | Range 响应异常/错位 | `scripts/security/suites/downloads.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-049 | P1 | downloads | 续传时资源变化 | `scripts/security/suites/downloads.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-050 | P1 | downloads | 网络断开/重试/取消 | `scripts/security/suites/downloads.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-051 | P1 | downloads | 强杀进程后恢复 | `scripts/security/suites/downloads.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-052 | P0 | downloads | 文件名穿越与特殊字符 | `scripts/security/suites/downloads.mjs` | unit/integration | 🟢 STRONG | MUT-19 |  |
| SEC-053 | P1 | downloads | 磁盘写满/权限拒绝 | `scripts/security/suites/downloads.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-054 | P1 | downloads | 并发限速与资源上限 | `scripts/security/suites/downloads.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-055 | P1 | downloads | 旧台账/损坏台账迁移 | `scripts/security/suites/downloads.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-056 | P1 | downloads | 下载校验 | `scripts/security/suites/downloads.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-057 | P0 | memory | 项目 A 记忆注入项目 B | `scripts/security/suites/memory.mjs` | unit/integration | 🟢 STRONG | MUT-20 |  |
| SEC-058 | P0 | memory | 不可信文档写入记忆 | `scripts/security/suites/memory.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-059 | P0 | memory | Memory 携带工具指令 | `scripts/security/suites/memory.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-060 | P1 | memory | 同名不同 Scope | `scripts/security/suites/memory.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-061 | P1 | memory | 用户纠正已存记忆 | `scripts/security/suites/memory.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-062 | P1 | memory | Expired/Superseded/Inactive | `scripts/security/suites/memory.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-063 | P1 | memory | 记忆数据损坏/迁移失败 | `scripts/security/suites/memory.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-064 | P1 | memory | 长上下文裁剪 | `scripts/security/suites/memory.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-065 | P1 | memory | 跨会话历史泄漏 | `scripts/security/suites/memory.mjs` | unit/integration | 🟢 STRONG | MUT-21 |  |
| SEC-066 | P2 | memory | 记忆召回可解释性 | `scripts/security/suites/memory.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-067 | P0 | privacy | API Key 在日志中出现 | `scripts/security/suites/privacy.mjs` | unit/integration | 🟢 STRONG | MUT-22 |  |
| SEC-068 | P0 | privacy | 敏感信息发送到未授权域 | `scripts/security/suites/privacy.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-069 | P0 | privacy | IPC/前端状态泄漏密钥 | `scripts/security/suites/privacy.mjs` | unit/integration | 🟢 STRONG | MUT-25 |  |
| SEC-070 | P1 | privacy | 配置备份/导出含敏感数据 | `scripts/security/suites/privacy.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-071 | P1 | privacy | 用户数据目录权限 | `scripts/security/suites/privacy.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-072 | P1 | privacy | 崩溃日志与异常堆栈 | `scripts/security/suites/privacy.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-073 | P1 | privacy | 原子写入 | `scripts/security/suites/privacy.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-074 | P1 | privacy | 数据删除/重置 | `scripts/security/suites/privacy.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-075 | P1 | privacy | 更新/迁移回滚 | `scripts/security/suites/privacy.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-076 | P2 | privacy | 日志保留与容量限制 | `scripts/security/suites/privacy.mjs` | unit/integration | 🟢 STRONG | — |  |
| SEC-077 | P0 | release | 生产依赖已知严重漏洞 | `scripts/security/suites/release.mjs` | unit/integration | 🟢 STRONG | MUT-23 |  |
| SEC-078 | P0 | release | 发布产物混入密钥/本地数据 | `scripts/security/suites/release.mjs` | unit/integration | 🟡 PARTIAL | — | 依赖 check-rules 的密钥扫描行 + 文件存在性，属静态字符串检查 |
| SEC-079 | P1 | release | 锁文件一致性 | `scripts/security/suites/release.mjs` | unit/integration | 🟡 PARTIAL | — | 只断言 lockfile 存在与版本号可读，未验证 integrity 与离线可装 |
| SEC-080 | P1 | release | Electron 安全配置回归 | `scripts/security/suites/release.mjs` | unit/integration | 🟡 PARTIAL | MUT-24 | 读源码 + 读构建产物做一致性比对，属配置面静态检查（无运行期窗口） |
| SEC-081 | P1 | release | 更新包来源/完整性 | `scripts/security/suites/release.mjs` | unit/integration | ➖ N/A | — | 本项目无自动更新机制（package.json 无更新依赖、代码无 autoUpdater），无来源/签名可校验 |
| SEC-082 | P1 | release | 生产构建调试能力 | `scripts/security/suites/release.mjs` | unit/integration | 🟡 PARTIAL | — | 读 main.cjs 源码判断 DevTools 分支与调试端口，属静态检查 |
| SEC-083 | P2 | release | SBOM / 依赖清单 | `scripts/security/suites/release.mjs` | unit/integration | 🟡 PARTIAL | — | 调用 npm ls 列依赖，证明可生成清单，未做完整性哈希 |
| SEC-084 | P2 | release | 安全审计日志 | `scripts/security/suites/release.mjs` | unit/integration | 🟢 STRONG | — |  |

> 「生产入口」是该项断言实际调用的生产模块/函数（不是标题复述）；类型按 testType 区分。
> PARTIAL 的成因两类：**配置面**（WebPreferences/CSP/构建一致性，无运行期等价物）与**确定性边界**
> （提示注入只验边界封装、未调模型）。**WEAK / UNVERIFIED 为 0** —— 无「只检查字符串或 Mock 自身逻辑」的断言被计入 PASS。
