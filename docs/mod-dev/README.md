# VelarOS Mod 开发者文档

面向**想给 VelarOS 加东西的人**：加一个工具、一段提示词、一个工作区、一块设置区，或者拦一下
agent 的运行时行为。

> **权威关系**：公开 Mod 契约由本套件、`packages/agent` / `packages/kernel` 中的版本化 schema
> 与对应的契约测试共同定义；通用边界见 [Platform boundaries](../architecture/platform-boundaries.md)。
> 文档与可执行契约冲突时必须在同一改动中修复，不能依赖仓外隐藏裁决。
>
> **宿主侧接线**：本套件定义 Mod 作者能依赖的平台面。具体产品拥有 loader 装配、安装 UI、市场入口
> 与产品策略，但不得扩写或改写公开 Platform 契约。
>
> 尚未实装的能力明确标为 **planned / not implemented**，不作为可用 API 或兼容承诺。

## 目录

| 文档                                           | 一句话                                                     |
| ---------------------------------------------- | ---------------------------------------------------------- |
| [getting-started.md](./getting-started.md)     | 从零写一个最小 mod：manifest → 本地安装 → 启停 → 读诊断    |
| [package-format-v1.md](./package-format-v1.md) | `.velarmod` 压缩包、扫描/信任/权限确认、内置构建与发布流程 |
| [axes/README.md](./axes/README.md)             | 十一根贡献轴的索引与总表（九根 agent 轴 + 两族 ui 轴）     |
| [seams.md](./seams.md)                         | Hook 生命周期：15 个 event、匹配/折叠语义与 5 个已接线事件 |
| [capabilities.md](./capabilities.md)           | capability token 与权限 broker；记忆后端当案例             |
| [product-agent-surfaces.md](./product-agent-surfaces.md) | 领域产品如何组合 State、Memory、Skill、Workflow 与 Agent 表面 |
| [integration.md](./integration.md)             | MCP / velar-hooks / 旧插件市场 三者与 mod 的定位边界       |
| [distribution.md](./distribution.md)           | bundled / installed / 市场 / 整合包，以及认证模型          |
| [conventions.md](./conventions.md)             | 数据生命周期、ownerModId、i18n、语义词汇墙与依赖方向       |

---

## 一、mod 是什么

一个 mod 的源码可以是一个目录，但标准交付单元必须是**一个 `.velarmod` 压缩包**，包根包含一份
`velaros.mod.json`。完整容器、扫描、权限确认和内置构建规则见
[package-format-v1.md](./package-format-v1.md)。目录只用于源码开发，不是可拖拽分发格式。

manifest 是**分节单文件**，内分三节，**各 owner 只读各节**：

| 节       | 读者           | 内容                                                                                                                                                                 |
| -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module` | **Kernel**     | 窄 module descriptor：`id` / `version` / `apiVersion` / `provides` / `requires` / `optionalRequires` / `permissions` / `isolation` + 装载寻址 `entry` / `exportName` |
| `agent`  | **Agent 主干** | 九根能力轴 + `engines` / `trust` / `requiredAxes` / `budget` / `entitlements` / `locale`                                                                             |
| `ui`     | **产品壳**     | 宿主专属 UI 声明；Platform 将其视为不透明信封，不承诺通用解析或兼容性                                                                                                |

「不透明信封」在这里比「透传」更强：**不是「读了但不解释」，而是根本不读别人那一节。**
唯一的跨节动作是**身份复核**——`module.id` 与 `agent.id` 不一致即拒载
（诊断码 `mod.envelope-id-mismatch`），因为一个 mod 不能有两个身份。

信封与 `module` schema 的唯一事实源在
`packages/kernel/src/contracts/protocol/mod-manifest.ts`：`VelarosModEnvelopeSchema`
（`z.strictObject`，发明第四节即拒载）、`VelarosModModuleSectionSchema` 与文件名常量。
Agent 只拥有 `packages/agent/src/protocol/mods.ts` 里的 `AgentModManifestSchema`。

> **旧格式已 clean break**：`velaros.agent.mod.json` 与常量 `AgentModPackManifestFileName`
> 已物理删除，不留文件名兼容。

## 二、两级注册机

```
第一级  Kernel Module Host
        只解析 module 节（窄 KernelModuleDescriptor），管模块生命周期与 isolation
        永不解析任何领域贡献轴

第二级  Agent 领域 Loader          packages/agent/src/mods/
        解析 agent 节，把贡献分发进九个注册面 + Hook 派发器

壳级    产品壳自己的注册表          解析 ui 节；不穿过 Kernel、不穿过 Agent 主干
```

pack 的**发现 / 校验 / 装载 / 启停**只有一个宿主入口。统一入口先解析一次
`velaros.mod.json`，再按 section 路由到 Kernel、Agent 与产品壳；各领域 Loader 只是入口内部的
owner，不是另一条安装或信任通道。

Agent owner 的接缝（`AgentModHostAssembly.ts`）读取每个启用 pack 的同一份信封：存在
`agent` 节才交给 `AgentModLoader`。`module.provides` 从此只声明真实 callable capability，
不能再兼任“这是 Agent pack”的路由标记。

## 三、生命周期

**Kernel module ABI**（第一级）：`register → activate → ready → suspend → dispose`

**mod 分发生命周期**（第二级，`AgentModLoader`）：

| 阶段           | 干什么                                                                                | 失败会怎样                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **discover**   | 从统一 pack 清单读取信封并按 `agent` section 路由（`discoverAgentModPackages`） | 跳过一律留痕：`mod.pack-disabled` / `mod.pack-agent-section-absent` / `mod.pack-unreadable` / `mod.pack-bindings-unloadable` |
| **validate**   | manifest schema + `engines` 三轴 + `trust` + 绑定完整性 + `requiredAxes`              | 拒载并给可读诊断                                                                                                                                     |
| **resolve**    | 平铺解析：mod id 唯一、轴内主键全宿主唯一（含工具名）                                 | 冲突 → **整包拒载**（`mod.duplicate-id` / `mod.tool-name-conflict` / `mod.contribution-conflict`），不做「后者覆盖前者」                             |
| **activate**   | 逐轴写进注册表，Hook 写进 `loader.hooks`，推进 generation                                  | —                                                                                                                                                    |
| **deactivate** | `loader.deactivate(modId)` 摘除全部贡献与钩子                                         | 留 `mod.deactivated` 诊断；**用户数据一律保留**（见 conventions.md）                                                                                 |

**铁律：validate 先于任何归一化。** 冲突、非法、缺绑定一律拒载并给可读诊断，
**绝不静默降级、绝不静默丢弃**。宽容只发生在**形态**层（标量 → 单元素数组、首尾空白），
语义层零宽容。

## 四、信任级（trust）

`AgentModTrustLevels`（`packages/agent/src/protocol/mods.ts`）：

| 值                   | 含义                  | 能力边界                                                 |
| -------------------- | --------------------- | -------------------------------------------------------- |
| `bundled-official`   | 随包官方              | 可使用进程内函数 binding；仍受声明、策略和权限门约束             |
| `marketplace-signed` | 市场签名              | 验签通过后，可按宿主公开目录请求权限与宿主实现的隔离载体         |
| `local-dev`          | 开发者本机 / 用户导入 | 未签名来源；可请求公开能力，导入/运行时均须显式批准，不得 import 进宿主 |

宿主用 `AgentModHostProfile.allowedTrustLevels` 决定放行哪些；**缺省 = `['bundled-official']`**
（fail-closed，见 `DefaultAllowedTrustLevels`）。不在集合内 → `mod.trust-not-allowed`。

产品宿主必须显式声明允许的信任级，并在自己的公开文档中说明签名、侧载和权限策略。
Platform 的安全缺省只允许 `bundled-official`；宿主没有显式放行时，其他信任级一律拒载。

## 五、partial activation 与 `requiredAxes`

同一个 mod 会面对能力不齐的宿主（Desktop 有壳、headless 没有）。语义只有两条：

1. **轴无落点 → 该轴缺席、mod 仍以 `partial` 态激活**，诊断码 `mod.axis-absent`，
   其余轴正常工作；
2. **`requiredAxes` 命中宿主不支持的轴 → 直接拒载**，诊断码 `mod.required-axis-unsupported`，
   **不做残废激活**。

宿主用 `AgentModHostProfile.supportedAxes` 自报支持哪些轴的落点。
`requiredAxes` 还有一条本地校验：**必须是自己实际贡献了条目的轴**，否则 manifest 解析阶段就报
`mod.required-axis-not-contributed`。

装载结果四态可查（`AgentModLoadReport`）：

```ts
{
  generation: number
  activated: readonly AgentModActivationState[]   // 含 status / activeAxes / absentAxes / contributionCount
  rejected:  readonly AgentModRejection[]         // 每条带 diagnostics
  diagnostics: readonly AgentModDiagnostic[]      // 含跳过、缺席、停用留痕
}
```

## 六、贡献机制是三件套，不止「声明贡献点」

| 机制             | 用途判据                                 | 形态                              | 文档                                              |
| ---------------- | ---------------------------------------- | --------------------------------- | ------------------------------------------------- |
| **① 声明贡献点** | 平台需要**索引 / 展示 / 惰性加载**的东西 | manifest 静态枚举                 | [axes/](./axes/README.md)                         |
| **② Hook**       | 需要**改变运行时行为**的东西             | 15 个闭集 event + matcher/mode/timeout | [seams.md](./seams.md)                            |
| **③ 开放数据面** | **平台还没想到、无法预先枚举**的东西     | custom entry / message + renderer | 数据形状走 Agent protocol，渲染走宿主定义的信任梯 |

一句话判据：没想到的**数据形状**走数据面；没想到的**行为**走 Hook；想清楚要**索引 / 展示**的
能力走声明贡献点。

**贡献点是封闭集合，由官方演进——mod 不能发明新贡献点、新轴、新 Hook event、新 manifest 节。**
觉得词表不够用，走沙箱 HTML（T2 档），不走「加个自定义词条」。

## 七、去哪找源码

| 东西                                                                                  | 落点                                                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| manifest 数据契约（zod / 轴闭集 / seam 闭集 / semver 判定 / `parseAgentModManifest`） | `packages/agent/src/protocol/mods.ts`（子路径 `@velaros-ai/agent/protocol/mods`） |
| 九轴注册面 + generation 快照 + 两阶段 + stale-reject                                  | `packages/agent/src/mods/AgentModRegistry.ts`                                     |
| 拦截 seam 注册面与派发器                                                              | `packages/agent/src/mods/AgentModSeams.ts`                                        |
| discover→validate→resolve→activate→deactivate                                         | `packages/agent/src/mods/AgentModLoader.ts`                                       |
| 快照 → 各领域消费面的纯函数投影                                                       | `packages/agent/src/mods/AgentModProjection.ts`                                   |
| 随包官方内置轴（第一个 bundled mod，自食狗粮）                                        | `packages/agent/src/mods/BuiltinAgentMod.ts`                                      |
| 宿主组装入口                                                                          | `packages/agent/src/mods/AgentModHostAssembly.ts`                                 |
| 唯一门面                                                                              | `packages/agent/src/mods/index.ts`                                                |
| 本仓落地形态与残余清单                                                                | [`docs/agent/agent-mod-trunk.md`](../agent/agent-mod-trunk.md)                    |
