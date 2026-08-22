# Agent Mod 主干（两级注册机的第二级）

> 本文记录 `packages/agent` 的 Mod 主干，并与 [Mod 开发者契约](../mod-dev/README.md)、
> 版本化 schema 和契约测试共同构成公开权威。通用所有权见
> [Platform boundaries](../architecture/platform-boundaries.md)。宿主产品只拥有装配适配器，
> 不得在仓外重新定义 Agent Mod 语义。

## 为什么主干住在这里

所有顶层应用（Desktop / Workbench / Extension / CLI）都需要 agent，因此**领域轴的注册机住 agent 域**。

```
第一级  Kernel Module Host（packages/kernel/src/runtime/host/）
        只解析窄 KernelModuleDescriptor { id, version, apiVersion, provides, requires, permissions, isolation }
        管 pack 的安装/启停/发现，永不解析领域贡献轴

第二级  Agent 领域 Loader（packages/agent/src/mods/）
        解析 AgentModManifest，把贡献分发进九个注册面 + 拦截 seam
```

Kernel 面收口不变：`createAgentKernelModule` 仍然只暴露 opaque `execute()`，Kernel 不吸收
任何领域 schema。宿主拿到 Kernel 的 pack 清单后，**自己**调 `assembleAgentMods` 装载
Agent 轴，再把组装好的 runtime 注入 kernel module。

## 落位文件

| 文件 | 职责 |
| --- | --- |
| `packages/agent/src/protocol/mods.ts`（子路径 `@velaros-ai/agent/protocol/mods`） | manifest 数据契约：zod schema、贡献轴闭集、seam 闭集、semver 判定、`parseAgentModManifest` |
| `packages/agent/src/mods/AgentModRegistry.ts` | 九轴贡献注册面 + generation 快照 + 两阶段 + stale-reject |
| `packages/agent/src/mods/AgentModSeams.ts` | 拦截 seam 注册面与派发器（异常隔离、权限不可旁路） |
| `packages/agent/src/mods/AgentModLoader.ts` | discover→validate→resolve→activate→deactivate 生命周期 |
| `packages/agent/src/mods/AgentModProjection.ts` | 快照 → 各领域消费面的纯函数投影 |
| `packages/agent/src/mods/BuiltinAgentMod.ts` | 随包官方内置轴 = 第一个 bundled mod（自食狗粮） |
| `packages/agent/src/mods/AgentModHostAssembly.ts` | 宿主组装入口：Kernel pack 清单 → Loader |
| `packages/agent/src/mods/index.ts` | 唯一门面（再经 `src/index.ts` 出包） |

探针：`packages/agent/test/protocol/mods.test.ts`、`packages/agent/test/mods.test.ts`（构造级，bun 直驱）、
`packages/agent/test/modSeamToolChain.test.ts`（装配面到工具缝的端到端回归门，见「派发点 ≠ 接线」）。

## Manifest 形状

```jsonc
{
  "id": "vendor.mod-id",
  "version": "1.0.0",                 // 必须是 x.y.z
  "publisher": "…", "displayName": "…", "description": "…",
  "manifestSchemaVersion": 1,         // 演进通道：加字段靠它平滑
  "engines": {
    "velaros": "^1.0.0",              // 必填：mod ↔ Kernel module API 兼容轴
    "agent": "^1.0.0",                // 可选：mod ↔ Agent capability API 兼容轴（领域轴）
    "shell": { "<shellId>": "^2.0.0" } // 可选：mod ↔ 产品壳兼容第二轴
  },
  "trust": "bundled-official | marketplace-signed | local-dev",
  "permissions": ["agent:execute"],   // v1 = 声明 + 审计元数据，不是既有可见性门的输入
  "requiredAxes": ["tools"],          // 硬需求轴：宿主不支持即拒载；必须是自己实际贡献的轴
  "entitlements": ["pro"],            // 占位：纯数据，核验住 Cloud + 市场，本层零商业判定
  "budget": { "residentPromptTokens": 1200 },
  "locale": { "zh-CN": { "key": "文案" } },  // 占位：字段形状定死，运行时合并链随市场批
  "contributes": { /* 见下表 */ }
}
```

宽容边界（ForgivingSchema 铁律的本地口径）：**形态层宽容、语义层零宽容**。
标量自动升成单元素数组、字符串自动 trim；未知字段 / 未知贡献轴 / 非法枚举 / 同轴主键重复 /
`requiredAxes` 越界一律**拒载并给可读诊断**，绝不静默丢弃；validate 必须先于任何归一化。

### 贡献轴（封闭集合，mod 不能发明新轴）

| 轴 | 主键 | 运行态绑定 | 说明 |
| --- | --- | --- | --- |
| `tools` | `name` | **必需** | 工具名全宿主唯一；冲突拒载 |
| `toolCategories` | `id` | 可选 | 工具类别定义 |
| `promptSegments` | `id` | 可选（否则须带 `text`） | 段正文二选一，都缺 = 拒载 |
| `skills` | `id` | 可选 | 技能定义 |
| `spaces` | `id` | **禁止** | 纯数据 descriptor：`identityStrategy` 闭集、`iconId` 数据化、常驻集与 turn-context 白名单 |
| `subAgentTypes` | `id` | 可选 | 子 agent 类型 |
| `turnContextSources` | `id` | **禁止** | per-turn 上下文源；mod 进入每回合上下文的唯一通道 |
| `executionModes` | `id` | 可选 | 执行模式 descriptor |
| `hooks` | `id` | **必需** | Hook event 挂接；编译期函数或宿主受控 command 适配为同形 binding |

壳级 UI 轴（`pages` / `settingsRenderers` / `surfaces` / `tours`）**不在 Agent 主干**——它们是产品壳
的不透明信封，归壳自己的 manifest 面。在 Agent manifest 里写它们 = 未知贡献点 = 拒载。

### partial activation

宿主用 `AgentModHostProfile.supportedAxes` 自报它支持哪些轴的落点：

- mod 的某轴无落点 → **该轴缺席、mod 仍以 `partial` 态激活**，诊断码 `mod.axis-absent`；
- `requiredAxes` 命中不支持的轴 → **直接拒载**，诊断码 `mod.required-axis-unsupported`，不做残废激活。

`AgentModLoadReport` 四态可查：`activated`（含 `status` / `activeAxes` / `absentAxes`）、
`rejected`（每条带 `diagnostics`）、`diagnostics`（含跳过与停用留痕）、`generation`。

## 注册面纪律（pi 吸收规则）

- **显式注入**：贡献只经 Loader 写入；消费链读 `snapshot()` 投影，不存在「拿到 registry 就地改」的通路。
- **每回合固定 generation 快照**：`registry.snapshot()` 冻结并带 generation，同一 generation 内复用同一对象。
- **registration / runtime 两阶段**：写入只在 registration 阶段；运行阶段写入即抛。
- **stale-reject**：`isStale()` / `assertFresh()`；generation 推进后旧快照判失效，绝不静默回退到旧值。
- 明确不做：全局 registry 即时修改、加载顺序覆盖（同 id 一律拒载而非后者覆盖）、giant context 注入。

## Hook 生命周期（机制②）

闭集 15 个 event（`AgentModHookEvents`）。manifest 标准字段是 `event`；`seam` 只作过渡
输入别名，解析后归一为 `event`。编译期与外部载体共用 matcher / mode / timeout /
context / outcome / 排序 / 诊断协议，只在运行容器与信任级上分流。三条不可协商性质：

1. **两阶段**：`beginRegistration()` → `register()` → `seal()`；封存后注册即抛。
2. **权限不可旁路**：钩子结果面只有「拦下」与「改写」，**没有放行字段**。
   `tool-call:before` 的入参改写发生在策略门**之前**，改写后照样过完整策略/校验/审批管线；
   会话生命周期钩子是纯通知，不能否决执行（准入单源仍是 `authGate` 与策略门）。
3. **异常隔离**：单 Hook 抛错只记诊断（`mod.seam-handler-failed`）并跳过；超时则
   abort `AgentModHookContext.signal` 并记 `mod.hook-timeout`，绝不冒泡打断主链。

`matcher` 字段间 AND、列表内 OR，事件缺字段时 fail-closed。`blocking` 按
`priority → modId → hookId` 确定性执行；`background` 只观察，返回的拦截/改写不进主链。
默认超时 5000ms，协议允许 100–30000ms。

### 已真接线的派发点

| seam | 调用点 | 语义 |
| --- | --- | --- |
| `tool-call:before` | `src/tools/Executor.ts` `runOne()`（策略门之前） | 可拦下（结构化失败结果 `tool_blocked`）或改写入参 |
| `tool-result:after` | `src/tools/Executor.ts` `finalizeResult()`（物化之前） | 可改写 result/error；放在物化前保证模型面与 UI 面同源 |
| `turn-context:assemble` | `src/agent/ContextBuilder.ts` `buildAsync()`（段排序后、预算裁剪前） | 异步宿主入口；可追加 dynamic 段，追加段同样计入 prompt 预算 |
| `session:start` / `session:end` | `src/kernel/execution/ExecutionService.ts` `runManagedExecution()` | 纯通知；`end` 在 finally，异常路径也发 |

四个调用点全部走 `seams?.has(kind)` 快路径——未注入或零钩子时行为逐字节不变。

### 派发点 ≠ 接线：装配面必须逐层透传（批 A2 的断链教训）

`tool-call:before` / `tool-result:after` 住在 `ToolExecutor` 里，而 `ToolExecutor` 是**每轮新建**的：
派发器不是全局单例，只能沿装配链一路传下去。批 A 只接了派发点、没接装配链，宿主注入的钩子
在工具缝上因此永远收不到派发（会话缝与回合上下文缝正常，故极易误判成「已接通」）。

透传路径（可选参，缺省 null → 全链 no-op）：

| 装配点 | 透传形态 |
| --- | --- |
| `SoloStreamLoop`（主面） | 构造第 8 参 `seams`；每轮 `ToolExecutor` 与缺页重放重建的那个都带上 |
| `QueryLoop`（子面） | 构造第 9 参 `seams` → 逐轮进 `ExecuteQueryTurnArgs.seams` |
| `QueryTurn` | 从 `args.seams` 传入 `ToolExecutor` options |

判据：**新增任何 `new ToolExecutor(...)` 的地方都必须带 `seams`**，否则该条执行路径就是钩子的盲区
（钩子只能减不能增，盲区意味着 mod 的「拦下」在这条路径上静默失效）。回归门探针见下。

## 宿主对接契约

```ts
import {
  assembleAgentMods,
  type AgentModHostProfile,
  type AgentModPackDescriptorLike,
  type AgentModPackReader,
  projectAgentModTools,
  projectAgentModPromptSegments,
} from '@velaros-ai/agent'

const host: AgentModHostProfile = {
  hostId: 'desktop',
  velarosVersion: '1.4.2',        // 对 engines.velaros
  agentApiVersion: '1.0.0',       // 对 engines.agent
  shellId: 'desktop',             // 可选；headless 宿主不声明
  shellVersion: '1.4.2',
  supportedAxes: ['tools', 'toolCategories', 'promptSegments', 'skills',
                  'spaces', 'subAgentTypes', 'turnContextSources',
                  'executionModes', 'hooks'],
  allowedTrustLevels: ['bundled-official'],   // 缺省即此值（fail-closed）
}

const { loader, report } = await assembleAgentMods({
  host,
  // bundled 缺省 = [createBuiltinAgentModPackage()]，官方内置恒加载
  packs: kernelModsListResponse.packs,   // KernelModPackDescriptor[]，结构鸭子类型即可
  reader,                                // 宿主实现 IO
})

const snapshot = loader.registry.snapshot()
const tools = projectAgentModTools(snapshot)
const segments = projectAgentModPromptSegments(snapshot)
```

### pack 布局与筛选规则

- 宿主从 `@velaros-ai/kernel/client` 的 `mods/list` 拿到 `KernelModPackDescriptor { id, kind, version, enabled, provides, specifier }`。
- **路由**：每个 `enabled === true` 的 pack 都从统一入口读取一次信封；存在 `agent` 节才归
  Agent owner。缺席留 `mod.pack-agent-section-absent` 诊断，`module.provides` 不参与领域路由。
- **布局**：`specifier` 指向 pack 包目录，其中必须有 `VelarosModManifestFileName`（= `velaros.mod.json`，
  见下节「分节单文件」）。读不出即拒载（`mod.pack-unreadable`）；文件在但没有 `agent` 节是另一种病，
  另给 `mod.pack-agent-section-absent`——两者都不静默跳过。
- **IO 全注入**：`AgentModPackReader.readManifest` / `loadBindings` 由宿主实现。主干零 fs 依赖，
  因此在没有 Kernel daemon 的宿主（headless / 测试台）里同样可用；信封验证复用
  `@velaros-ai/kernel/contracts/protocol` 的唯一 schema，pack descriptor 仍以结构化契约声明。
  `readManifest` 返回的是**整份信封**，取 `agent` 节是主干的事。
  产品宿主必须公开自己是否实现 `loadBindings`。未实现时，外部 pack 不能贡献需要代码绑定的
  `tools` 或 `hooks`；实现 command Hook 的宿主必须先将其适配为 `AgentModHookHandler`，
  并在宿主边界执行路径包含、权限、超时、输出上限和进程约束。Loader 不为安全缺口降级。

### 分节单文件 `velaros.mod.json`

一个 mod = 一个 manifest 文件，内分三节，**各 owner 只读各节**：

| 节 | 读者 | 内容 |
| --- | --- | --- |
| `module` | **Kernel** | 窄 module descriptor：`id` / `version` / `apiVersion` / `provides` / `requires` / `optionalRequires` / `permissions` / `isolation` + 装载寻址 `entry` / `exportName` |
| `agent` | **Agent 主干** | 九轴 manifest（本文上半部分那一份，**内容零变化**，只是搬进信封） |
| `ui` | **产品壳** | 壳级轴；Agent 侧**不解析**，读都不读 |

```json
{
  "module": {
    "id": "acme.notes",
    "version": "1.2.0",
    "apiVersion": 1,
    "provides": [{ "id": "acme.notes", "version": "1.0.0" }],
    "requires": [],
    "permissions": ["project:read"],
    "isolation": "in-process",
    "entry": "./index.js"
  },
  "agent": {
    "id": "acme.notes",
    "version": "1.2.0",
    "manifestSchemaVersion": 1,
    "engines": { "velaros": "^1.0.0", "agent": "^1.0.0" },
    "trust": "marketplace-signed",
    "contributes": {
      "tools": [{ "name": "notes_search", "categoryId": "notes" }]
    }
  },
  "ui": { "pages": [{ "id": "acme.notes.page" }] }
}
```

要点：

- **节的闭集**：`strictObject`，发明第四节即拒载——否则「谁读它」没有答案。
- **形态层宽容**：`provides` / `requires` 的条目写裸 id 字符串等价于 `{ id }`，`version` 缺省 `1.0.0`；
  语义层零宽容（非法枚举、未知字段照旧拒载）。
- **唯一的跨节动作是身份复核**：`module.id` 与 `agent.id` 不一致 → `mod.envelope-id-mismatch` 拒载
  （安装器按前者落盘、注册机按后者记账，两个身份之后永远对不上）。
  两节都带 `id`/`version` 是已知冗余；未来若收拢到顶层，必须提升 schema 版本并提供迁移说明。
- **把整份信封当 agent 节喂给 `parseAgentModManifest`** 会得到专门的 `mod.manifest-is-envelope` 诊断，
  而不是难懂的「未知字段 module」。
- **clean break**：旧文件名 `velaros.agent.mod.json` 与常量 `AgentModPackManifestFileName` 已删除，
  不留兼容。

#### 宿主迁移（Desktop / Workbench reader）

reader 侧改动只有两点，其余零变：

1. 文件名常量换成 `VelarosModManifestFileName`（`velaros.mod.json`）——多数宿主的 reader 直接用
   `readManifest({ manifestFileName })` 传进来的值，改完 import 名即可；
2. 宿主如果**自己**从 manifest 里读身份（如 Desktop `AgentModPackStore` 的 `readManifestIdentity`
   读顶层 `id`/`version`），改成读 `module` 节。

Loader / 投影 / 绑定装载 / 诊断消费面**一律不变**：主干仍然拿到 agent 节，`AgentModPackage.manifest`
的语义没动。

### 数据生命周期

`loader.deactivate(modId)` 摘除该 mod 的全部贡献与钩子，并留 `mod.deactivated` 诊断：
**其产出的持久化数据一律保留**（orphaned-but-preserved），重新装载即复活。主干不删任何用户数据；
`uninstall` 的两段式清理与 `ownerModId` 归属索引由宿主和各数据 owner 负责。

## 内置消费者验证

`createBuiltinAgentModPackage()` 把 Agent Runtime 自带的三轴做成第一个 bundled mod
（`velaros.agent.builtin`，trust=`bundled-official`，恒加载），与外部 mod 走**同一条**管线：

- `tools` ← 九个内置工具集合展平（`activeDirectiveTools` … `plansTools`）；
- `promptSegments` ← `createBuiltInPromptSegments()`；
- `executionModes` ← `listExecutionModes()`。

行为零变化的两条结构性保证：

1. manifest 由既有单源**派生**（`Object.keys(collection)` / 两个 list 函数），不另立清单 → 不可能漂移；
2. 绑定直接引用原实体，Loader 与投影全程不复制不包装 → **载荷对象同一性逐项保持**。

探针 `mods.test.ts` 断言：工具清单集合相等且逐项 `toBe` 同一对象；提示词段 id/顺序/stability/priority
与 `createBuiltInPromptSegments()` 逐项相等且是绑定里的同一批定义对象；执行模式同理。

技能轴**刻意缺席**——Agent Runtime 自身不带内置技能定义（技能由宿主的文件式供应方注入），
声明空轴只会制造零消费者的假贡献。

## Known limitations

**未接线的 seam kind（只有注册面与类型，dispatch 无调用点）**：
`turn:start`、`turn:end`、`prompt:compose`、`tool-call:after`、`model-request:before`、
`model-response:after`、`sub-agent:dispatch`、`compaction:before`、`skill:select`、`diagnostic:publish`。
接线时的注意点：`turn:*` 需要给 `AgentLoopSurface` 加派发器字段并由 Solo/Query 两面装配；
`sub-agent:dispatch` 落 `kernel/dispatch/SubAgentDispatcher.ts`；`compaction:before` 落上下文治理链。

**未落的轴与字段**：

- 壳级 UI 轴（pages / settingsRenderers / surfaces / tours）归产品壳，不进 Agent manifest。
- `memoryScope`（记忆作用域策略）是具体能力包的语义，不属 Agent 中立主干；
  应由该能力包自己的领域 manifest 轴承载。`check:agent-arch` 的架构哨兵也禁止 `packages/agent`
  (含 `protocol` 子路径)出现具体能力词汇。
- `locale` 运行时合并链、`entitlements` 核验、`budget` 消费：字段形状已定，消费方随各自里程碑。
- 签名验签 / 版本化寻址 / 回滚：属第一级（Kernel pack 管道）的增强，不在本主干。
- 数据 `ownerModId` 归属索引与 uninstall 两段式清理：归宿主与数据 owner。
- `manifestSchemaVersion` 的跨版本迁移器：v1 只有一个版本，迁移通道留着未用。

## 偏离与理由

| 设计候选 | 当前落地 | 理由 |
| --- | --- | --- |
| `contributes.promptFeatures` | `contributes.promptSegments` | 主干实际的领域轴是 prompt 段注册表（`PromptRegistry`），特性 id 是段的激活谓词输入，不是独立注册面 |
| `SpaceContribution.memoryScope` | 未落 | 具体能力语义，见残余清单 |
| `engines` 双轴 | 三字段（velaros / agent / shell） | 领域 manifest 还需声明 Agent capability API 版本 |
| 依赖求解 | 无 | 本协议只做 semver 兼容判断；复杂求解属于包管理器职责 |
