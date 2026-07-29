# VelarOS Mod 开发者文档

面向**想给 VelarOS 加东西的人**：加一个工具、一段提示词、一个工作区、一块设置区，或者拦一下
agent 的运行时行为。

> **权威关系**：本套件是**参考手册**，不是判决源。架构判决住 **VelarOS-Desktop 仓**的
> `docs/mod-architecture-blueprint.md`（蓝图 v6）与 `docs/kernel-contract.md`（§15 进程拓扑判决）。
> 两者冲突时以那两份为准，改本套件。
> 本套件的每个 API 名 / 字段名 / 文件名都对得上本仓 `packages/**` 或 Desktop 仓的真实代码；
> 判决已定但尚未实装的部分一律标注「**契约已定，实装批次 X**」，不当成能用的东西写。

## 目录

| 文档 | 一句话 |
| --- | --- |
| [getting-started.md](./getting-started.md) | 从零写一个最小 mod：manifest → 本地安装 → 启停 → 读诊断 |
| [axes/README.md](./axes/README.md) | 十一根贡献轴的索引与总表（九根 agent 轴 + 两族 ui 轴） |
| [seams.md](./seams.md) | 拦截 seam：改变运行时行为的那条缝，15 个 kind、4 个已接线 |
| [capabilities.md](./capabilities.md) | capability token 与权限 broker；记忆后端当案例 |
| [integration.md](./integration.md) | MCP / velar-hooks / 旧插件市场 三者与 mod 的定位边界 |
| [distribution.md](./distribution.md) | bundled / installed / 市场 / 整合包，以及认证模型 |
| [conventions.md](./conventions.md) | 数据生命周期、ownerModId、i18n、语义词汇墙与依赖方向 |

---

## 一、mod 是什么

一个 mod = **一个目录 + 一份 `velaros.mod.json`**。

manifest 是**分节单文件**，内分三节，**各 owner 只读各节**：

| 节 | 读者 | 内容 |
| --- | --- | --- |
| `module` | **Kernel** | 窄 module descriptor：`id` / `version` / `apiVersion` / `provides` / `requires` / `optionalRequires` / `permissions` / `isolation` + 装载寻址 `entry` / `exportName` |
| `agent` | **Agent 主干** | 九根能力轴 + `engines` / `trust` / `requiredAxes` / `budget` / `entitlements` / `locale` |
| `ui` | **产品壳** | 壳级轴：`ui.settings`（已实装）+ `ui.dock` / `ui.actions` / `ui.sidePanels`（契约已定，实装批次 W1） |

「不透明信封」在这里比「透传」更强：**不是「读了但不解释」，而是根本不读别人那一节。**
唯一的跨节动作是**身份复核**——`module.id` 与 `agent.id` 不一致即拒载
（诊断码 `mod.envelope-id-mismatch`），因为一个 mod 不能有两个身份。

信封 schema 在 `packages/agent/src/protocol/mods.ts`：`VelarosModEnvelopeSchema`（`z.strictObject`，
发明第四节即拒载）、`VelarosModModuleSectionSchema`、`AgentModManifestSchema`。
文件名常量 `VelarosModManifestFileName = 'velaros.mod.json'`。

> **旧格式已 clean break**：`velaros.agent.mod.json` 与常量 `AgentModPackManifestFileName`
> 已物理删除，不留文件名兼容。

## 二、两级注册机

```
第一级  Kernel Module Host
        只解析 module 节（窄 KernelModuleDescriptor），管模块生命周期与 isolation
        永不解析任何领域贡献轴

第二级  Agent 领域 Loader          packages/agent/src/mods/
        解析 agent 节，把贡献分发进九个注册面 + 拦截 seam

壳级    产品壳自己的注册表          解析 ui 节；不穿过 Kernel、不穿过 Agent 主干
```

pack 的**发现 / 校验 / 装载 / 启停**唯一 owner = **Agent 平台主干的 Loader 一处**
（kernel-contract §15.1 原则三：每份状态单一 owner）。Kernel 保留 module ABI 的生命周期原语，
但不持有 pack 管理。

宿主在两级之间做三件事（`AgentModHostAssembly.ts`）：
按 `provides` 筛出含 Agent 轴的 pack → 读 pack 目录里的 `velaros.mod.json` 并**取 agent 节** →
连同运行态绑定喂给 `AgentModLoader`。

## 三、生命周期

**Kernel module ABI**（第一级）：`register → activate → ready → suspend → dispose`

**mod 分发生命周期**（第二级，`AgentModLoader`）：

| 阶段 | 干什么 | 失败会怎样 |
| --- | --- | --- |
| **discover** | 从 Kernel pack 清单折算候选包（`discoverAgentModPackages`）；bundled 走构建图不走发现 | 跳过一律留痕：`mod.pack-disabled` / `mod.pack-not-agent-axis` / `mod.pack-unreadable` / `mod.pack-no-agent-section` / `mod.pack-bindings-unloadable` |
| **validate** | manifest schema + `engines` 三轴 + `trust` + 绑定完整性 + `requiredAxes` | 拒载并给可读诊断 |
| **resolve** | 平铺解析：mod id 唯一、轴内主键全宿主唯一（含工具名） | 冲突 → **整包拒载**（`mod.duplicate-id` / `mod.tool-name-conflict` / `mod.contribution-conflict`），不做「后者覆盖前者」 |
| **activate** | 逐轴写进注册表，钩子写进 seam 派发器，推进 generation | — |
| **deactivate** | `loader.deactivate(modId)` 摘除全部贡献与钩子 | 留 `mod.deactivated` 诊断；**用户数据一律保留**（见 conventions.md） |

**铁律：validate 先于任何归一化。** 冲突、非法、缺绑定一律拒载并给可读诊断，
**绝不静默降级、绝不静默丢弃**。宽容只发生在**形态**层（标量 → 单元素数组、首尾空白），
语义层零宽容。

## 四、信任级（trust）

`AgentModTrustLevels`（`packages/agent/src/protocol/mods.ts`）：

| 值 | 含义 | 能力边界 |
| --- | --- | --- |
| `bundled-official` | 随包官方 | 可贡献代码钩子（工具 handler / seam handler） |
| `marketplace-signed` | 市场签名 | 声明式贡献 + 官方定义的 handler 模板；**该信任级的加载路径尚未落地** |
| `local-dev` | 开发者本机 | 本机全权、不分发 |

宿主用 `AgentModHostProfile.allowedTrustLevels` 决定放行哪些；**缺省 = `['bundled-official']`**
（fail-closed，见 `DefaultAllowedTrustLevels`）。不在集合内 → `mod.trust-not-allowed`。

> **Desktop 现状**：`createDesktopAgentModHostProfile`
> （`apps/desktop/src/main/kernel/AgentModRuntime.ts`）硬编码
> `allowedTrustLevels: ['bundled-official']`。也就是说今天在 Desktop 上侧载一个
> `trust: 'local-dev'` 的 pack 会被直接拒载。详见 [getting-started.md](./getting-started.md#六现状与限制先读这条)。

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

| 机制 | 用途判据 | 形态 | 文档 |
| --- | --- | --- | --- |
| **① 声明贡献点** | 平台需要**索引 / 展示 / 惰性加载**的东西 | manifest 静态枚举 | [axes/](./axes/README.md) |
| **② 拦截 seam** | 需要**改变运行时行为**的东西 | 15 个闭集钩子 | [seams.md](./seams.md) |
| **③ 开放数据面** | **平台还没想到、无法预先枚举**的东西 | custom entry / message + renderer | 蓝图裁决 9 ③；数据形状走 Agent protocol，渲染走壳的三档梯 |

一句话判据：没想到的**数据形状**走数据面；没想到的**行为**走 seam；想清楚要**索引 / 展示**的
能力走声明贡献点。

**贡献点是封闭集合，由官方演进——mod 不能发明新贡献点、新轴、新 seam kind、新 manifest 节。**
觉得词表不够用，走沙箱 HTML（T2 档），不走「加个自定义词条」。

## 七、去哪找源码

| 东西 | 落点 |
| --- | --- |
| manifest 数据契约（zod / 轴闭集 / seam 闭集 / semver 判定 / `parseAgentModManifest`） | `packages/agent/src/protocol/mods.ts`（子路径 `@velaros-ai/agent/protocol/mods`） |
| 九轴注册面 + generation 快照 + 两阶段 + stale-reject | `packages/agent/src/mods/AgentModRegistry.ts` |
| 拦截 seam 注册面与派发器 | `packages/agent/src/mods/AgentModSeams.ts` |
| discover→validate→resolve→activate→deactivate | `packages/agent/src/mods/AgentModLoader.ts` |
| 快照 → 各领域消费面的纯函数投影 | `packages/agent/src/mods/AgentModProjection.ts` |
| 随包官方内置轴（第一个 bundled mod，自食狗粮） | `packages/agent/src/mods/BuiltinAgentMod.ts` |
| 宿主组装入口 | `packages/agent/src/mods/AgentModHostAssembly.ts` |
| 唯一门面 | `packages/agent/src/mods/index.ts` |
| 本仓落地形态与残余清单 | [`docs/agent/agent-mod-trunk.md`](../agent/agent-mod-trunk.md) |
