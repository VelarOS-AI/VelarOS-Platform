# 开发约定

写 mod 时会撞上的红线、惯例与现状。

---

## 一、数据生命周期

盘上数据（会话 / 记忆 / 存储分区 / config）以枚举值或 `ownerModId` 引用 mod。
mod 可禁用、可卸载，所以**孤儿语义必须先定义**：

| 动作 | 语义 |
| --- | --- |
| **install** | 注册，**不触碰用户数据** |
| **enable / disable** | disable = 下次启动不加载贡献；**其贡献引用的既有用户数据保留、标记为 orphaned-but-preserved**，重新 enable 后复活 |
| **uninstall** | **两段式**——先 disable，再由用户**显式确认「清理数据」**才删除关联数据；默认保留，提供「导出后删除」路径；**永不静默硬删** |
| **upgrade** | manifest 带 config / data migration 声明；跨版本迁移经一次性迁移器；`engines` 不兼容则**拒绝加载新版并保留旧数据** |

**空间 mod 特例**：停用一个 space mod → 该空间的会话 / 记忆变孤儿态，
UI 显示「该工作区所属 mod 已停用，数据已保全，可重新启用或导出」，**绝不静默蒸发**。

主干侧今天做到的：`loader.deactivate(modId)` 摘除贡献与钩子，留 `mod.deactivated` 诊断，
**主干不删任何用户数据**。两段式 uninstall 与 `ownerModId` 归属索引归**宿主与各数据 owner**，
**契约已定，实装未开始**。

### `ownerModId`

非空间数据（记忆条目、scheduler 任务、per-mod config）当前**没有「哪个 mod 产出」的所有者标签**，
所以通用孤儿追踪没有落地锚点。补法只有一条：
**mod 贡献产生持久化数据时，写入期落 `ownerModId` 归属标签 + 建反查索引。**

没有这个索引，「orphaned-but-preserved」与「重新 enable 后复活」都**不可计算**。

一条例外见 [capabilities.md §5.5](./capabilities.md#55-与数据生命周期的对齐)：
记忆域的 `ownerModId` 打在**派生索引**一侧，**权威文件不打 mod 标签**——
权威内容不属于任何 mod，一旦打上，卸载语义就又变回「数据跟着 mod 走」。

---

## 二、工具参数的宽容铁律

工具是 mod 最常贡献的东西，而工具参数直接吃模型输出。铁律：

> **可引用句柄 / 钳制不拒绝 / strip 不 strict / 缺参给默认 /
> 字段无歧义时推断 action / 自动过滤器与 scaffold 不得静默否决显式意图。**

现成原语在 `packages/core/src/utils/ForgivingSchema.ts`：

| 原语 | 用途 |
| --- | --- |
| `clampedInt(min, max)` | 越界**钳制**而不是报错 |
| `withDefaultNote(schema, …)` | 缺参给默认并留可读说明 |
| `preferFirst(...)` | 多个同义字段取第一个非空 |
| `emptyIsNoop(value)` | 空数组 / 空对象判为 no-op，而不是「非法」 |
| `inferActionFromFields(...)` | 字段无歧义时推断 `action` |
| `buildAppliedAdjustments(...)` / `AppliedAdjustment` | 把「我替你改了什么」回报给模型 |
| `buildValidItemsHint(...)` | 报错时告诉模型合法值是什么 |

注意这与 **manifest** 的宽容口径**不同**：manifest 是
**形态层宽容、语义层零宽容**（未知字段即拒载）。
两处口径不同是有意的——manifest 的读者是开发者与安装器，工具参数的读者是模型。

---

## 三、语义词汇墙与依赖方向

### 层间依赖单向

```
⑤ 宿主层        Desktop / Workbench / velaros serve / 瘦客户端
④ 能力 mod 列    workspace / browser / model / memory / office / computer
③ Agent 平台主干  loop + 九轴注册机 + seams + 会话权威 + 上下文治理
② Kernel 库      module host + capability registry + 权限 broker + 事件流 + state
① 契约层        纯类型，零运行时
```

**依赖方向 ⑤ → ④ → ③ → ② → ①，反向 import 由 arch-guard 锁死。**

### 语义词汇墙

**认识领域词汇的东西不属于内核基础层。**
一件东西若其类型或行为里出现「聊天 / 回合 / 工具结果 / 压缩 / 工作区 / 记忆」这类**域名词**，
它就不属于 Kernel；只认识「模块 / 能力 / 权限 / 事件 / 状态 / 引用 / 错误」的才留。

机械形态：`packages/core/src/kernel/**` 有硬墙——出现 `memory` 这类词即判红。
这就是为什么记忆后端的 capability token 住 `packages/memory/src/adapter-kernel/`
而不是 core。

### 对 mod 作者的三条推论

1. **别指望 Kernel 认识你的领域。** 它不解析 `tools` / `spaces` / `promptSegments`，
   也不解析 `ui` 节的任何字段。
2. **别在 `agent` 节里写壳级轴**（`pages` / `settingsRenderers` / `surfaces` / `tours`）——
   未知贡献点 = 拒载。
3. **别建第二条注入路。** 能力进入产品只有主干一条路（主干的注册机与 seams）。
   宿主不得自建第二条工具注册面、第二个上下文装配器、第二套会话权威；
   mod 同理不得绕过 Loader 往运行时塞东西。

---

## 四、i18n 现状

**v1 = 编译期字面量为主。**

manifest 的 `locale` 字段**形状已定死**：

```ts
locale: z.record(TrimmedIdSchema, z.record(TrimmedIdSchema, z.string())).optional()
// { "<locale>": { "<key>": "<译文>" } }
```

**但运行时 locale 查询链的合并实现尚未落地**——它随市场链路（M5 档）。
理由：唯一需要运行时 locale 包（而非编译期 key）的群体是外部 mod，
而外部代码 mod 到 M5 才落地；提前建 merge 链会连续三个里程碑零消费者。

实践口径：

- **bundled mod**：继续用编译期 `MessageKey`（Desktop 的
  `renderer/src/i18n/messages/{zh-CN,en-US}.ts`）；
- **外部 mod**：`descriptor.label` 这类字段今天就写**字面量**，
  `locale` 可以先填着（形状合法、不会拒载），但**不要指望它生效**；
- `AgentModSpaceContribution.descriptor.localeKey` 同理——字段在，链没接。

---

## 五、命名

| 概念 | 对外口径 |
| --- | --- |
| **mod** | 机制名。manifest / 安装器 / 注册表 / 生命周期都叫这个 |
| **插件** | 旧词，一词多义（`AppResourcePlugin` 那一套）。**新代码不要用它指 mod** |
| **扩展** | 泛指，不作为机制名 |

**收敛的是机制，不是用户心智。** 技能页、市场页、设置分类按领域分视图**照旧**——
普通用户不该被强加「mod」心智。Mod 注册表是**开发者 / 高级视图入口**，
不是设置页本身（类比：VS Code 的 Extensions 面板与 Settings 是两个东西）。

`ui.settings` 的 `domain` 闭集里**刻意排除了** `plugins` / `tools` / `mods`
——见 [axes/ui-settings.md](./axes/ui-settings.md#domain落进哪个功能领域区)。

---

## 六、代码卫生（贡献到本仓时）

- **恒等转发类无聊函数一律清理，调用点内联**——无域语义的一行转发函数禁止，
  有含义才配有名字。
- **绝不留双脑**：每收敛 / 迁移一处，立即物理删除旧硬编码路径，
  不许「先留旧逻辑兜底」。若判断某处必须暂时并存，**显式说明并给出消解时点**。
- **拒载优先于静默降级**：这是 mod 系统里最容易被违反的一条。
  静默丢弃一个贡献，用户看到的是「装了但没用」，且无从排查。

---

## 附：文档-代码漂移清单

写本套件时核对出的、**文档与代码对不上的地方**。只做记录，不改代码。

| # | 漂移 | 实形 |
| --- | --- | --- |
| 1 | 蓝图 §3.3 的 `SpaceContribution` | 真名 `AgentModSpaceContribution`（`packages/agent/src/protocol/mods.ts`）。另有 Desktop 的**同名不同形** `SpaceDescriptor`（7 字段，`DesktopCapabilityScopeDescriptors.ts`） |
| 2 | 蓝图 §3.3 / §3.2 说 gate2 是 `source.spaces` | 真实字段是 `TurnContextDeltaSource.scopes`（`packages/core/src/types/turnContext.ts`） |
| 3 | 蓝图 §3.2 的 `contributes.promptFeatures` | 落地名 `promptSegments`（已在 `docs/agent/agent-mod-trunk.md` 登记偏离） |
| 4 | Desktop `docs/spaces-composable-dispatch.md` 指向 `../VelarOS-Kernel/packages/core/src/spaces/spaceDescriptors.ts` 并称「九字段」 | 该仓 / 该文件**不存在**；活的是 `DesktopCapabilityScopeRegistry`，7 字段 |
| 5 | `docs/mcp-integration-config.md` 说 `McpServerConfig` 住 `packages/core/src/types/system.ts` | 实住 Desktop 仓 `packages/ipc/src/desktopConfigContracts.ts` |
| 6 | `ToolRenderRegistry.ts` 文档注释示范 `defineToolRenderRegistration({...})` | 该函数**不存在**；真实用法是 `const registration: ToolRenderRegistration = {...}; export default registration` |
| 7 | 蓝图与本文均提 `VELAROS_PLUGIN_ARTIFACT_BASE` | Desktop / Platform 运行时代码**都不读它**；只在一条构建脚本注释里被提到，指 Cloud 侧变量。Desktop 的产物 base 是装配期注入的函数 `cloudAccountService.getPluginArtifactBaseUrl()` |
| 8 | `agent-mod-trunk.md` 的宿主对接契约含 `AgentModPackReader.loadBindings` | Desktop 的 `createDesktopAgentModPackReader()` **只实现 `readManifest`**；结果是 installed pack 贡献不了 `tools` / `hooks` |

### 附带发现的两个疑似运行时缺陷（未修，仅登记）

| # | 现象 |
| --- | --- |
| A | turn-context 源 `task.lifecycle`（`packages/agent/src/kernel/background-jobs.ts`）声明 `scopes: []`，而 `ChatTurnContextFanIn.peek()` 的 gate2 判定是 `source.scopes.includes(space)` → **恒 false**。三个空间的 gate1 白名单都列了它，实际永远拿不到 delta |
| B | `workspace.editor-focus` / `workspace.editor-selection` 出现在 gate1 白名单（`DesktopCapabilityScopeDescriptors.ts`）、渲染层 id 允许表与 UI 类型联合里，但**两仓都没有对应的 `TurnContextDeltaSource` producer** |

另外两条「声明了但没人读」的死声明面：
Desktop `SpaceDescriptor.memoryScope`（`SpaceMemoryScopeKind`）无读取者，
真正的映射在 `resolveDesktopMemoryScope` 的 if-链里；
Platform `getWorkspaceSpaceIconName` 是与 `SpaceDescriptor.iconName` **并行的第二份硬编码 switch**，
两者靠人工同步。
</content>
