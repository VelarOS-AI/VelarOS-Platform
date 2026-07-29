# 三项收敛定位：MCP / velar-hooks / 旧插件市场

VelarOS 里有三样东西容易和 mod 混淆。本页写**判决口径的边界**：谁是什么、
谁最终会并进 mod 轴、谁永远不会。

| | 是什么 | 与 mod 的关系 | 现状 |
| --- | --- | --- | --- |
| **MCP** | 外部工具服务器协议 | **mod 可声明的贡献形态**（VS Code 先例：接入通道保留运行时协议） | 接入实现在 Desktop；**轴化时机待裁** |
| **velar-hooks** | **宿主自动化 API** | **边界写死不许混**：外部 agent 驱动应用走 hooks，mod 内代码走 seam / capability | 已实装（loopback HTTP + SSE） |
| **旧插件市场 / AppResourcePlugin** | 固定 id 闭集 + latest-only 安装器 | **P5 收敛对象**：mod 分发通道的旧壳 | 仍在跑；7 个 id 的闭 enum |

---

## 一、MCP —— mod 可声明的贡献形态

### 现状

MCP 支持分两半：

**host 无关的一半**（本仓，`@velaros-ai/agent`）
`packages/agent/src/tool-library/mcp/`：

| 文件 | 导出 |
| --- | --- |
| `McpClientConnection.ts` | `McpClientConnection`、`McpConnectTimeoutMs`（30 s）、`McpCallTimeoutMs`（120 s）、`McpConnectionSpec`、`McpToolDescriptor`、`McpToolAnnotations`、`McpRawCallResult` |
| `mcpToolTranslation.ts` | `translateMcpTool`、`buildMcpToolName`、`convertMcpInputSchema`、`TranslatedMcpTool`、`McpAutoApprovePolicy` |
| `mcpCallResult.ts` | `translateMcpCallResult` |

SDK 是 `@modelcontextprotocol/sdk`，transport **只有 stdio**（`StdioClientTransport`）。

**Desktop 装配的一半**（`apps/desktop/src/main/tools/mcp/`）：
`McpServerManager`（`start()` / `stop()`）与 `McpToolProvider`
（`implements ToolProvider`，`kind = 'mcp'`，id 形如 `` `mcp:${serverName}` ``）。

声明形状（`packages/ipc/src/desktopConfigContracts.ts`）：

```ts
interface McpServerConfig {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: Nullable<string>
  enabled: boolean
  autoApprove: boolean | string[]
}
```

住 `SystemConfig.mcpServers`，落 `settings.json` 的 `system.mcpServers`。
工具名经 `buildMcpToolName` 生成 `` mcp__<server>__<tool> ``（超 64 字符时截断 + 6 位 sha256 后缀），
统一落 `DefaultMcpToolCategoryId = 'general'`——**刻意不为 MCP 新增封闭轴枚举**。
渲染层零 MCP 存在：没有设置 UI、没有 IPC 通道。

### 与 mod 的关系

**今天：零关系。** MCP 代码不提 `velaros.mod.json` / `AgentMod*`；
mods 代码不提 MCP；`AgentModContributionAxisNames` 里没有 `mcp` 轴。
唯一的共同落点是 `ToolRegistry.registerProvider`——两者都变成 tool provider，
但走的是完全不相交的代码路径。

**判决口径**：MCP 是一个**mod 可以声明的贡献形态**，不是一个平行的扩展系统。
参照 VS Code 的先例——扩展可以声明它带一台 MCP server，
但**接入通道本身保留为运行时协议**（stdio / 传输层不变成声明式 DSL）。

**轴化时机待裁。** 在裁之前不要：

- 往 `agent.contributes` 里发明 `mcp` 轴（未知轴 = 拒载）；
- 假设 mod 能通过 manifest 声明一台 MCP server；
- 把 MCP 的 `autoApprove` 与 mod 的 `permissions` 混为一谈——前者是工具审批策略，
  后者是尚未 enforce 的声明元数据。

---

## 二、velar-hooks —— 宿主自动化 API

### 这是什么

**外部进程驱动整个应用**的 API：发任务、观察运行态、批准确认、切页面、改配置、截图。
它服务的是「让一个外部 agent 或脚本操作 VelarOS」，不是「让 mod 扩展 VelarOS」。

实现住 Desktop 主进程 `apps/desktop/src/main/hooks/`：
`VelarHookRuntime`、`VelarHookCommandGateway`、`VelarHookHttpServer`、
`VelarHookSessionCatalog`、`VelarHookGuideRelay`、`VelarHookBridgeReady`、
`DesktopHookWindowRouting`、`VelarHooksIpc`。
契约在 `packages/ipc/src/desktopHookContracts.ts`。

入口是 **loopback HTTP + SSE**（`VelarHookHttpServer` 绑 `127.0.0.1`）：

```
GET  /v1/hooks/health
GET  /v1/hooks/events
GET  /v1/hooks/stream      SSE
POST /v1/hooks/commands    body = VelarHookCommand
```

Bearer token 鉴权（`VELAR_HOOKS_TOKEN`，缺省随机），端口 `VELAR_HOOKS_PORT`（缺省 `48741`），
端点握手文件由 `VelarHookEndpointStore` 写出（`VELAR_HOOKS_ENDPOINT_FILE`，
缺省 `<tmpdir>/velaros-hooks-endpoint.json`）。
CLI 客户端：`scripts/tools/velar-hooks.mjs`。
应用内路径是 IPC 通道 `velar-hooks:list-events` / `velar-hooks:invoke-command`。

命令面是判别联合 `VelarHookCommandKind`（25 个 kind），
派发是 `VelarHookCommandGateway` 里一个**穷举 `switch`**，每个 case 委托给
`VelarHookCommandAdapters` 里的一个适配器。

### 边界：两个「hook」不许混

| | **velar-hooks** | **mod manifest 的 `hooks` 轴** |
| --- | --- | --- |
| 类型 | `VelarHookCommandKind` | `AgentModSeamKind` |
| 落点 | `packages/ipc/src/desktopHookContracts.ts` | `packages/agent/src/protocol/mods.ts` |
| 方向 | **外→内**：外部进程驱动应用 | **内→外**：mod 代码拦截 agent 循环 |
| 传输 | loopback HTTP / SSE + Electron IPC | 进程内派发 |
| 值举例 | `'send_task'`、`'focus_session'`、`'plugin_op'` | `'session:start'`、`'turn:end'`、`'tool-call:before'` |

**这条边界写死**：

- **外部 agent 驱动应用 → 走 hooks**；
- **mod 内代码改行为 → 走 [seam](./seams.md)**；
- **mod 内代码要真副作用 → 走 [capability](./capabilities.md)（过 broker）**。

不要用 hooks 实现 mod 的功能（那等于给自己造第二条注入路），
也不要指望 seam 能驱动 UI（seam 只在 agent 循环里跑）。

代码层面两者从未相交：`grep VelarHook` 在 mods 目录 0 命中，反向也是 0。

> 唯一的间接关联：hook 命令 `plugin_op` 驱动的是**旧插件市场**（下一节），不是 mod。

---

## 三、旧插件市场 / AppResourcePlugin —— P5 收敛对象

### 现状

| 标识 | 落点 |
| --- | --- |
| `AppResourcePluginId`（type） | `packages/ipc/src/desktopAppResourceContracts.ts` |
| `AppResourcePluginInstaller`（class） | `apps/desktop/src/main/resources/AppResourcePluginInstaller.ts` |
| `AppResourcePluginService`（class） | `apps/desktop/src/main/resources/AppResourcePluginService.ts` |
| `AppResourcePluginIdList` / `isAppResourcePluginId` | `apps/desktop/src/shared/constants/appResourcePlugins.ts` |

记录类型叫 `AppResourcePluginRecord`（**没有**叫 `AppResourcePlugin` 的类型）。

**id 是闭集 enum，7 个**：

```ts
type AppResourcePluginId =
  | 'codegraph' | 'markitdown' | 'cloakbrowser' | 'computeruse'
  | 'whisper'   | 'web-agent-bridge' | 'airjelly-injector'
```

三处 `Record<AppResourcePluginId, …>` 穷举同一闭集
（`PluginToolDirs` / `PluginDescriptors` / 七个 per-plugin resolver 字段），
**加一个插件今天要改至少 4 个文件**。
注意 `computeruse` 的目录名是 `'computer-use'`，与 id 不同。

### 安装管道现状（如实登记）

`AppResourcePluginInstaller.runInstall(id)`：
`downloading` → `verifying` → `extracting` → `rm(toolDir)` + `rename(extractDir, toolDir)`
→ `activating`。

| 能力 | 有没有 |
| --- | --- |
| sha256 校验 | ✅ `verifyChecksum`，流式，失败给 `AppError('VALIDATION','checksum-mismatch')` |
| 密码学签名验签 | ❌ **不存在**（`AppResourcePluginInstaller` 里零签名代码） |
| 版本化寻址 | ❌ **不存在**——装载目标是无版本的 `join(root, PluginToolDirs[id])`，磁盘上只能有一个版本 |
| 回滚 | ❌ **不存在**——先 `rm` 旧目录再 `rename` 新目录，两步之间崩溃就是「插件没了且无从恢复」 |

存储：`<root>/plugin-resources/<toolDir>/`，无版本段、无本地 manifest、无 lockfile；
启停状态在 `settings.json` 的 `system.appResourcePlugins.disabled[]`。

产物源不是环境变量：base 是**装配期注入的函数**
（`artifactBase: () => cloudAccountService.getPluginArtifactBaseUrl()`，
返回 `` `${baseUrl}/v1/plugins/` ``）。
`VELAROS_PLUGIN_ARTIFACT_BASE` **在 Desktop / Platform 两仓的运行时代码里都不存在**——
它只在一条构建脚本注释里被提到，指的是 **Cloud 侧**读的环境变量。
本地验证的现成机制是 `file://` base（installer 的 `readTextResource` / `openArtifactStream`
都特判了 `file:` 协议）。

### 收敛判决

| 系统 | 轴归属 | 收敛时机 |
| --- | --- | --- |
| **插件市场 / AppResourcePlugin** | **唯一安装器**（版本化寻址 + 签名 + 回滚）+ 唯一注册表 | 安装器基建随**第一个非 bundled 消费者**落地；id 闭集开放化随 **M2c** |

**收敛的是机制，不是用户心智**——技能页、市场页、设置分类按领域分视图**照旧**。
普通用户不该被强加「mod」心智。

### 对比：mod 自己的存储

mod 的 pack 存储与旧插件完全分离：
`storage/mods/<packId>/` + `storage/mods/mod-registry.json`
（`storagePathService.getModPacksDir()`），走 `DesktopAgentModPackStore`。
两者今天各管各的——这正是「一个安装器」判决要消掉的重复。
</content>
