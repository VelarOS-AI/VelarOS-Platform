# packages/kernel 按仓库标准改造方案

> 对象：`~/Desktop/VelarOS/projects/VelarOS-Platform/packages/kernel`（`@velaros-ai/kernel` 0.2.3）。分析期间仓库 HEAD 从 `16206d66` 走到 `b9c2746e`，收尾复核时已到 `134e1d51`（别的实例在提交 agent、text-files、memory、model、path-rules），**`packages/kernel` 自始至终一个字节没变**（最后一次改动仍是 `3c6e7c19`，工作区对本包无改动；`src` 107 个文件 14,097 行、`test` 25 个文件 5,394 行两次实测一致）。agent 已完成第 2 步整文件搬家（`540de0e6`），本文 agent 侧的消费方路径按搬家后的磁盘为准。行号以 `b9c2746e` 为准（本包未变，行号在 `134e1d51` 上同样成立）。消费方扫描在 `134e1d51` 上重跑过一遍，第 1.3、6 节的数字是重跑后的；与首轮相比只有四处变化（`./contracts/abi` 的 Platform 侧 25 → 28、`./contracts/protocol` 6 → 5、`./remote/client` 4 → 6，消费文件合计 61 → 65），都来自别的实例在改能力包，被用到的 59 个名字一个没变。
> 标准：`docs/architecture/module-ownership.md`、ADR 0003 / 0005 / 0007 / 0008，样板 `packages/system`、`packages/project`、`packages/platform`、`packages/shell-command`、`packages/rehearsal-sandbox`，门禁 `scripts/ownership/check-module-ownership.mjs` 与登记表 `scripts/ownership/governed-modules.mjs`。流水账 `docs/engineering/foundation-refactor-log.md` 里已定的事照用、不再论证：wire 类型手写 + schema `satisfies z.ZodType<…>`、可移植数据只有一个文件、入口平铺不带 `/`、不留兼容层、每步提交不推送、并行时用临时索引提交。另参考 Desktop 仓的内核宪章 `docs/kernel-contract.md`（§3、§4、§15）。
> 方法：只读。数字来自脚本实测（TypeScript AST 与类型检查器；消费方扫描覆盖 Platform 的 `packages/*`、`tests/`、`scripts/`、`products/`，另加 Desktop、Workbench、Termel、Extension、VelarScript-Libraries，跳过 `scratchpad/`、`node_modules`、`dist`）。缺陷凡是标了探针的都复现过；探针只 import 源码，落盘只在草稿区。脚本与原始数据见附录 B。
> 基线：`packages/kernel` 下 `bun test test`：144 pass / 0 fail（23 个测试文件，0.45 秒），跑完工作区干净。

## 0. 结论先行

1. **规模**：`src/` 106 个 `.ts`（外加 `velaros-globals.d.ts`）14,096 行、18 个子目录；38 个类另 20 个错误类，实现接口的只有 12 个；18 个 `index.ts`（12 个是入口、6 个是中间 barrel）；53 处包名自引用。12 个入口共导出 777 个名字，按声明去重 500 个（类 37、错误类 20、函数 91、常量 102、接口 140、类型别名 108、命名空间 2）。测试 25 个文件 5,394 行，`bun test test` 144 pass / 0 fail；远程节点 17 个文件 2,478 行在本仓零测试。
2. **真被用到的只有 59 个名字**（65 个消费文件：Platform 8 个包 36 个、Desktop 16、Workbench 5、Termel 8；另有 14 个文件只把包名当字符串提到——门禁脚本与配置，其中 VelarScript-Libraries 按 dist 路径读 wire schema）。根入口 `.`、`./contracts`、`./serve/updater` 零消费；`./contracts/protocol` 的 67 个 zod schema 没有一个被 import；`./client` 176 个导出只用了 4 个。
3. **主要问题**：结构上没有五目录，ABI 与 wire 各有一套同名类型（`ScopeRef` 等四组，靠命名空间隔开），类、错误类、零件大面积出包（根入口导出 15 个类、11 个错误类），26 个类不实现接口、12 个文件多个类，semver 三份、`isNodeError` 七份、锁文件两份，约 190 条英文的用户/模型可见文字；退役的 HostBridge/sidecar 整条链还在，写死了 agent/model/browser 三个能力和浏览器操作名；实现层缺陷 24 条（探针复现 13 条），最重的两条是 sidecar 适配器对未知操作放行（权限闸被绕过）和 `velaros-kernel-daemon` 默认装配根本起不来。
4. **目标**：`src/` 收成 contract/types/impl/utils/exports；impl 47 个类文件分 6 个域子目录（runtime、serve、client、updater、remote-client、remote-node）、3 层；utils 约 37 个文件；types 7 个文件、`types/kernel.ts` 是唯一可移植文件；错误类 20 → 4，全部带码、不出包；入口 12 → 5：`.`（进程内内核 + 模块 SDK，渲染进程可加载）、`./contracts`、`./client`（瘦客户端）、`./serve`（守护进程、启动器、更新器）、`./remote`（远程节点两端，带 `ws`）——后三个都是 Node 专用，各有独立的消费方和依赖，留下的理由见 2.6。门禁规则不用改。
5. **要拍板的**（第 7 节 13 项，1–6 先定）：入口收口与类不出包（`new Kernel()` → `createKernel()`、SDK 改 `kernelModules.*`、错误按码、升 0.3.0）；删 HostBridge/sidecar（ABI 里的 `'sidecar'` 值留不留）；删零调用的身份注册 RPC；`mods.*` 留不留；进程内调用补「调用方归属」（Desktop 可删掉自己复刻的调用路径）；事件订阅者失败隔离。
6. **步骤**（八步，第 6 节）：登记（迁移中）→ 去自引用和 barrel（导出面不变）→ 删死代码、逐条修缺陷并补远程测试 → 整文件搬家 → 拆混合文件、闭包改类、错误类合并 → 合同、接口、常量、文字中文化 → 入口收口 0.3.0 → 卡片、不变量、验收。**第 0–5 步入口名一个不改、`exports` 一个不删，只删全仓零消费的导出，八个能力包与三个产品零改动**；第 6 步一次收口，下游 65 个 import 文件（Platform 36、Desktop 16、Workbench 5、Termel 8）加 11 个门禁脚本跟改，其中真要动代码的只有四类：SDK 三个顶层函数改实例方法、`new Kernel()` 改工厂、4 处 `instanceof` 改按码、memory 的 `new KernelModuleHost` 改 `createKernel()`。
7. **排期上最要紧的一条**：`./contracts/abi` 是全仓被消费最多的入口（40 个文件、八个能力包的内核模块全靠它），第 6 步把它并进根入口会横切八个正在各自改造的包——**kernel 的第 6 步要钉在 model 开工之前**，否则 model、office、computer 要为同一件事改两遍（第 6.3 节第一条）。

## 1. 现状

### 1.1 目录与职责

| 目录 | 文件 | 行 | 职责 |
| --- | ---: | ---: | --- |
| `src/index.ts` | 1 | 4 | 根入口：`export *` abi、service、runtime |
| `contracts/abi/` | 9 | 484 | 模块 ABI：能力令牌、模块清单与定义、激活上下文、服务句柄、事件、权限请求、作用域/资源引用、状态面、两个版本常量；混着 `createKernelCallableCapability` 等 6 个 SDK 函数和 1 个错误类 |
| `contracts/protocol/` | 10 | 978 | wire 协议：67 个 zod schema 与 `z.infer` 类型（能力调用信封、能力会话、握手、身份、mods RPC、mod 清单信封 `velaros.mod.json`、远程节点帧），协议版本与握手判定，schema 注册表（构建时出快照） |
| `contracts/service/` | 3 | 36 | 服务面数据：健康度、身份注册入参 |
| `contracts/index.ts` | 1 | 4 | `./contracts` 入口：`KernelAbi`、`KernelProtocol` 两个命名空间 + service |
| `runtime/`（根） | 3 | 394 | `Kernel` 门面（进程内 `new Kernel()`）、`KernelCapabilityInvoker`（进程内与 serve 共用的唯一调用路径）与 5 个调用错误类 |
| `runtime/host/` | 12 | 2,476 | 模块宿主 `KernelModuleHost`（注册、依赖解析、激活/就绪/替换/挂起/释放、回滚、组合快照）、服务登记表、事件总线、权限缺省与模块视图、状态后端、semver、错误类；HostBridge 注册表与 sidecar 适配器（退役残留） |
| `runtime/service/` | 6 | 867 | `KernelService`：把宿主投影成 wire 协议面（握手、健康、会话打开判定、能力调用、身份注册、mods 管理）；能力会话账本、客户端绑定策略、身份注册表 |
| `client/`（含 `contracts/`） | 12 | 1,448 | 瘦客户端：`KernelClient`、`CapabilitySession`、Unix socket / 回环 TCP 传输、守护进程发现与连接、`KernelLauncher`（启动或附着共享进程）、descriptor / endpoint / RPC 帧契约、错误类 |
| `serve/`（根、daemon、internal、rpc） | 13 | 2,168 | 守护进程装配 `bootKernelDaemon`、单实例锁与 descriptor、本机 NDJSON RPC 服务、进程内传输、ModStore / ModLoader、编译期 bundled pack（sidecar 桩）、可执行入口 `main.ts` |
| `serve/updater/` | 14 | 1,839 | 共享 Runtime 安装器：更新清单、下载与校验、解包、安装记录、激活指针与回滚、跨进程更新锁、自带一份 semver |
| `remote/`（根、shared） | 6 | 664 | 远程节点两端共用：清单投影成本机模块与工具（命名空间化）、`isolation: 'remote'` 适配器、Ed25519 密钥与 challenge、帧编解码、清单修订号 |
| `remote/client/` | 8 | 1,297 | 完整宿主一侧：`RemoteNodeClient`（配对、认证、判活、退避重连、epoch 判死）、在途调用簿、握手判定、关闭码判定、凭据文件、`ws` 套接字 |
| `remote/node/` | 8 | 1,437 | 无头节点一侧：`RemoteNodeServer`（握手状态机、单客户端）、调用执行与终态回放缓存、并发闸、配对闸、审计日志、凭据文件、端口探测监听 |

### 1.2 子系统怎么串

- **进程内**（Desktop、Workbench）：宿主 `new Kernel({ permissionBroker, stateBackend, lifecycleFailureMode })` → `registerModule(...)`（能力包的 `create*KernelModule()`）→ `start()`：`KernelModuleHost` 解析依赖图（稳定拓扑序）→ 逐个 `activate(context)`（上下文里是按声明收窄的服务解析器、模块事件视图、模块权限视图、命名空间状态）→ 全部 `ready` → `invokeCapability(call)`：`KernelCapabilityInvoker` 按 id 取当前活动令牌 → 取服务 → 查操作元数据（未知操作在求权限前拒绝）→ 逐条权限问宿主注入的 `KernelPermissionBroker`（缺省全拒）→ 调 provider。Desktop 壳 UI 的能力调用另走 `resolveCallableCapability` + `requestCapabilityPermission(…, attribution)` 自己拼了一条（缺陷 D17）。
- **serve**（Termel）：`bootKernelDaemon({ modules | modPacks, permissionBroker, paths })` → ModStore / ModLoader 得到模块 → 同一个 `KernelModuleHost` → `KernelService`（协议面，复用同一个 invoker）→ `KernelLocalDaemon`（先拿单实例锁、再起 RPC、写 descriptor）→ `KernelLocalRpcServer`（NDJSON；认证令牌常数时间比较；每连接一本能力会话账本，调用必须落在打开会话时声明的能力、操作、作用域内）。Termel 同进程另用 `new KernelClient(new InProcessKernelTransport(booted.service))`。
- **附着**（Termel attached-host）：`connectToKernelDaemon(paths)` 读 descriptor → socket 传输 → 握手 → 版本精确比对 → `openCapabilitySession(...)` → `session.call(...)`。
- **启动器 / 更新器**：`KernelLauncher` 发现不到守护进程就按 `KernelVersionResolver` 给的入口 spawn 并轮询 descriptor；`KernelUpdater` 负责下载、校验、原子安装、切指针、健康检查回滚。两者之间的解析器没人实现，全仓没有一处把它们接起来。
- **远程节点**（agent 的远程工具与 MCP 桥、Termel）：Node 侧 `RemoteNodeServer` 监听（缺省只回环，端口 43180–43190）→ hello → challenge →（首次）配对码 + 公钥 /（已配对）签名 → ready 下发清单 → invoke / cancel，终态进按 callId 的回放缓存。Client 侧 `RemoteNodeClient` 连接、判活、退避重连、epoch 变化判「结果未知」；主机端 `createRemoteNodeProjection` 把远端清单改名成 `velaros.remote.<slug>.*` 的代理模块，`RemoteNodeIsolationAdapter` 作为 `isolationAdapters` 注入内核，调用先过本机权限闸再上线。

### 1.3 对外入口：导出了什么、谁在用

统计口径：「导出」来自类型检查器对 12 个入口文件的 `getExportsOfModule`；「被用」指至少一个消费方文件 import 了该名字（包内自引用不算）。

| 入口 | 导出 | 其中值 | 被用 | 消费方（文件数） | 判定 |
| --- | ---: | --- | ---: | --- | --- |
| `.` | 115 | 44（15 类、11 错误类、15 函数、3 常量） | 0 | — | 零消费；把 runtime 整个带出去，含 `node:net`（sidecar），渲染进程不能加载 |
| `./contracts` | 7 | 2 个命名空间 | 0 | — | `KernelAbi` / `KernelProtocol` 命名空间只为隔开同名类型 |
| `./contracts/abi` | 40 | 10 | 18 | Platform 28、Desktop 8、Workbench 3、Termel 1 | 主力：八个能力包写内核模块的 SDK |
| `./contracts/protocol` | 128 | 70（67 个 zod schema） | 8 | Platform 5、Desktop 5、Termel 3 | schema 一个都没被 import（VelarScript codegen 按 dist 路径读除外） |
| `./runtime` | 72 | 34 | 5 | Workbench 4、Desktop 3、Platform 2（memory） | `Kernel` 类、两个错误类、memory 直接 new `KernelModuleHost` |
| `./client` | 176 | 87 | 4 | Termel 3 | 把 `./contracts/protocol` 整个转发了一遍 |
| `./client/contracts` | 24 | 6 | 2 | Termel 2 | |
| `./serve` | 37 | 25 | 4 | Termel 1 | |
| `./serve/updater` | 89 | 50 | 0 | — | 零消费 |
| `./remote` | 30 | 21 | 1 | Termel 1 | 只用 `createManifest` |
| `./remote/client` | 35 | 16 | 6 | Platform 6（agent）、Termel 1 | |
| `./remote/node` | 24 | 9 | 11 | Termel 1 | |

各入口里有什么（源文件是对应目录的 `index.ts`）：

- `.`：abi 全部、service 数据、runtime 全部——`Kernel`、`KernelModuleHost`、`KernelService`、`KernelServiceStore`、`ScopedKernelServiceResolver`、`KernelEventHub`、`CapabilitySessionLedger`、`KernelIdentityRegistry`、两个缺省权限/绑定策略、`InMemoryKernelStateBackend`、`HostBridgeClient`、`SidecarIsolationAdapter`、`KernelHostBridgeRegistry`，宿主零件函数（`validateManifest`、`resolveKernelModulePlan`、`createScopedPermissionBroker`、`createNamespacedStateStore`、`satisfiesVersionRange`、`toError`、`parseHostBridgeEndpoint`、`defaultHostBridgeSocketPath`……）与 11 个错误类。
- `./contracts/abi`：ABI 接口与数据 30 个，`createCapabilityToken`、`requireCapability`、`defineKernelModule`、`createKernelCallableCapability`、`isKernelCallableCapabilityService`、`resolveKernelCapabilityOperationReason`，`KernelVersion`、`KernelModuleApiVersion`、`KernelModuleIsolationValues`，`UnknownKernelCapabilityOperationError`。
- `./contracts/protocol`：67 个 schema、58 个类型、`parseVelarosModEnvelope`、`negotiateKernelProtocol`、`isKernelProtocolAccepted`、远程节点的版本与 5 个数字上限、关闭码表、`KernelProtocolWireSchemas`。
- `./runtime`：同 `.` 去掉 abi 与 service。
- `./client`：`KernelClient`、`CapabilitySession`、`SocketKernelTransport`、`KernelLauncher` 四个类，发现与连接函数，descriptor 路径与解析，`KernelRpcMethods`、`KernelCapabilityGrantErrorCodes`，3 个错误类，外加整个 `./contracts/protocol` 与两个命名空间。
- `./serve`：`bootKernelDaemon`、`installKernelShutdownHandlers`，bundled pack 的 5 个辅助与 `BundledKernelPacks`，ModStore / ModLoader 与索引读写，`KernelLocalDaemon`、`KernelLocalRpcServer`、`InProcessKernelTransport` 与 RPC 帧辅助。
- `./serve/updater`：`KernelUpdater`、`KernelUpdateLock`、两个缺省扩展点类，27 个函数、13 个 zod schema、3 个错误类、`nodeKernelFetch`。
- `./remote`：`RemoteNodeIsolationAdapter`、`createRemoteNodeProjection` 与三个命名函数，密钥 / challenge / 配对码 / 帧 / 清单修订号共 11 个函数，`RemoteNodeModuleApiVersion` 等 3 个常量。
- `./remote/client`：`RemoteNodeClient`、`RemoteNodePendingCalls`、`FileRemoteNodeCredentialStore`，握手与关闭码判定、退避计算、缺省凭据路径，5 个调优常量、错误码表、错误类、`createRemoteNodeWebSocket`。
- `./remote/node`：`RemoteNodeServer`、`RemoteNodeCallRunner`、`RemoteNodeInvocationPool`、`RemoteNodeResultCache`、`RemoteNodePairingGate`，两个文件存储工厂，`RemoteNodeCompletedCallCapacity`、`RemoteNodeSocketPath`。

**真被用到的 59 个名字**（V = 值，T = 只作类型）：

| 入口 | 名字 | 消费方 |
| --- | --- | --- |
| `./contracts/abi` | T `CapabilityToken` | agent/computer/model/office/project 测试、memory、project `ProjectTools`、system `SystemTools` 与 spec、Desktop `StoreRegistry` |
| | T `KernelCallableCapabilityService` | agent `AgentKernelModule`、browser/computer/model/office 的 `kernel-module.ts`、project 与 system 的 `contract/provides.ts`、Desktop `ModCapabilityBroker`、`mainRegistry` |
| | T `KernelModuleActivateContext`、`KernelModuleDefinition`、`KernelModuleHealth`、`KernelCallableCapabilityOperation`、`KernelCapabilityOperationMetadata`、`KernelStateStore`、`KernelEvent`、`ScopeRef` | 八个能力包的内核模块与测试、agent `utils/toolkit/callable-operations.ts`、computer `contracts/index.ts`、Desktop `RuntimeTypes`/`mainRegistry`、Workbench `WorkbenchKernelIpc` 与测试 |
| | T `KernelPermissionBroker`、`KernelPermissionDecision`、`KernelPermissionRequest` | Desktop `ModPermissionBroker`/`ExternalModCommandRuntime`/`ModCapabilityBroker`/两个测试、Workbench `WorkbenchKernelPermissionPolicy`、Termel `permission-policy` |
| | V `createCapabilityToken`、`defineKernelModule`、`KernelModuleApiVersion` | 八个能力包、memory 探针与测试、Desktop `mainRegistry` |
| | V `createKernelCallableCapability` | agent、browser、computer、model、office、project、system |
| | V `UnknownKernelCapabilityOperationError` | Workbench `WorkbenchKernelIpc`（`instanceof`） |
| `./contracts/protocol` | V `VelarosModManifestFileName`、`parseVelarosModEnvelope` | agent `AgentModHostAssembler`、`VelarModArchiveImporter`、`utils/wire/mods.ts`（浏览器面）；Desktop `AgentModPackStore`、`ModMarketStaging`、两个 `ExternalMod*Bindings` 与测试；Termel `plugins.ts` |
| | T `RemoteNodeManifest`、`RemoteNodeToolDescriptor` | agent `RemoteHostService`、`RemoteHostToolFactory`、`RemoteNodeMcpServer`；Termel `remote-node.ts` |
| | T `RemoteNodeCapabilityDescriptor`、`KernelModuleDescriptor`、`CapabilityCallResponse`、`ScopeRef`（wire） | Termel `remote-node.ts`、`tool-gateway.ts` |
| `./runtime` | V `Kernel` | Desktop `Composition.ts`、`scripts/checks/kernelAssembly.mjs`；Workbench `main/index.ts`、`kernelHostProbe.ts`（类型位另有 2 处） |
| | V `KernelCapabilityPermissionDeniedError`、`KernelCapabilityUnavailableError` | Workbench `WorkbenchKernelIpc`（`instanceof`） |
| | V `KernelModuleHost` | memory `memory-store-capability-probe.ts`（在 `probe:memory` 里，属 `check:gates`）、`test/adapter-kernel/mount.test.ts` |
| | T `KernelStateBackend` | Desktop `DesktopKernelStateBackend` |
| `./client` | V `KernelClient`、`connectToKernelDaemon`、`KernelProtocolVersion`；T `CapabilitySession` | Termel `host.ts`、`attached-host.ts`、`tool-gateway.ts` |
| `./client/contracts` | T `KernelDaemonPaths`、`KernelRpcEndpoint` | Termel `data-root.ts`、`host.ts` |
| `./serve` | V `bootKernelDaemon`、`InProcessKernelTransport`、`createDefaultKernelModStorePaths`；T `BootedKernelDaemon` | Termel `host.ts` |
| `./remote` | V `createManifest` | Termel `remote-node.ts` |
| `./remote/client` | V `RemoteNodeClient`、`RemoteNodeClientError`、`FileRemoteNodeCredentialStore`、`defaultRemoteNodeCredentialsPath`；T `RemoteNodeCredentialStore`、`RemoteNodeCredentials` | agent `RemoteHostService`、`RemoteHostToolFactory`、`RemoteNodeMcpServer`、`utils/connectors/stdio-entry.ts`；Termel e2e 测试 |
| `./remote/node` | V `RemoteNodeServer`、`createRemoteNodeFileAuditLog`、`createRemoteNodeFileCredentialStore`；T `RemoteNodeActivityEvent`、`RemoteNodeAuditSink`、`RemoteNodeCapabilityInvokeRequest`、`RemoteNodeCapabilityInvokeResult`、`RemoteNodeCapabilityInvoker`、`RemoteNodeCredentialStore`、`RemoteNodeManifestSource`、`RemoteNodePairedCredential` | Termel `remote-node.ts` |

**绕过入口、按路径写死内核源码或产物的地方**（搬家时最容易漏）：

| 位置 | 写死了什么 |
| --- | --- |
| `scripts/mod/velaros-mod.mjs:9-12`（根脚本 `bun run mod`） | 直接 import `packages/kernel/src/contracts/protocol/mod-manifest.ts` |
| `packages/kernel/scripts/generate-schema-snapshot.mjs:12-13`（`build` 的一步） | 读 `src/contracts/protocol/handshake.ts`、`schema-snapshot.ts` |
| `scripts/kernel/check-arch-boundaries.mjs` | 按路径钉 `src/contracts`、`src/runtime`、`src/client`、`src/serve/updater`、`src/contracts/protocol`，以及 `runtime/Kernel.ts`、`serve/daemon/boot.ts`、`runtime/service/KernelService.ts` 里的标记串 |
| `eslint/kernel.config.mjs:311-347` | 按 `src/client/**`、`src/contracts/**` 限制 import |
| `scripts/model/check-arch-boundaries.mjs:107` | model 只许 import `@velaros-ai/kernel/contracts/abi` |
| 根 `tsconfig.json:75-80` | `@velaros-ai/kernel` → `packages/kernel/src/index.ts`，`/*` → `src/*` |
| `bun.lock:210` | bin `velaros-kernel-daemon` → `./dist/serve/main.js` |
| VelarScript-Libraries `packages/contract-codegen/tests/support/platform.mjs:20` 与已提交的 `kernel.manifest.json`、`kernel.report.json` | 读本地 Platform 的 `packages/kernel/dist/contracts/protocol/index.js`，把 56 个 schema 当真实目标 |
| `scripts/kernel/check-package-consumers.mjs` | 孤儿门禁（没有任何 npm 脚本调用）；断言 `main === ./dist/index.js`、`files` 含 `docs`，改造后必然不成立 |
| `scripts/capabilities/check-packed-consumers.mjs:813` | 孤儿门禁，运行期 import `@velaros-ai/kernel/contracts/abi`（归 capabilities，只提醒） |

### 1.4 与别的包的耦合

- **依赖**：`@velaros-ai/core`（根：类型守卫、`Log`、缺席值、`stringifyPretty`；子路径 `utils/TimerScope`（远程两端、启动器）、`utils/FilePersistence`（远程凭据）、`utils/nullish`（boot））、`zod`（wire、更新清单、凭据文件）、`ws`（远程两端）。28 个文件用 Node 内置模块（`net`、`fs`、`crypto`、`os`、`path`、`child_process`、`http`、`url`）。
- **被依赖**：Platform 8 个包以 `workspace:*` 依赖（agent、browser、computer、memory、model、office、project、system）；Desktop 钉 `^0.2.3`，Workbench 与 Termel 两个包钉 `0.2.3`。
- **包名自引用**：`src` 里 30 个文件 53 处、`test` 里 24 处，靠 `tsconfig` 的 `paths` 指回 `src`；`remote/` 两个文件经根入口 `@velaros-ai/kernel` 引 runtime。门禁的分层检查看不见这些依赖、`move-files.mjs` 也不改写它们，所以第 1 步先去掉。
- **包内重复**（收成单源）：semver 三份（`runtime/host/version.ts`、`serve/updater/version.ts`、`contracts/protocol/mod-manifest.ts` 的正则），口径不一（D14）；`isNodeError` 七份（discovery、daemon、mod-loader、local-rpc-server、updater/fs-utils、remote/node/credential-store、listener）；pid 锁文件两份（`serve/daemon/daemon.ts`、`serve/updater/lock.ts`，带同一个竞态 D9）；原子写 JSON 三份（updater/fs-utils、daemon 写 descriptor、remote/node/credential-store），而 core 已有 `writeJsonFileAtomically`；「是不是可调用服务」「模块 API 版本」各抄一遍（D15）。
- **跨包重复**：更新器按平台算安装根（`LOCALAPPDATA` / `XDG_DATA_HOME` / `~/Library/Application Support`），和 `@velaros-ai/platform` 的 `velarosSharedResources.dataRoot()` 是同一套惯例，而且 Linux 上一个叫 `velaros`、一个叫 `VelarOS`；远程凭据与 sidecar 路径直接读 `process.env.HOME`，没有就退到 `/tmp`（D7）。
- **下游对内部零件的依赖**：memory 的 `probe:store-capability` 直接 `new KernelModuleHost`；Desktop 的 `ModCapabilityBroker` 复刻了一条调用路径（D17）；Workbench 用 `instanceof` 判三个错误类；agent 用 `instanceof RemoteNodeClientError`。

### 1.5 写死了具体空间或宿主知识的地方

| 位置 | 写死了什么 |
| --- | --- |
| `runtime/host/sidecar-bridge.ts:471-500` `discoverBridgeOperations` | 按浏览器能力的操作名逐个猜探测：`health`、`execute`、`supports_provider`、`open_page`、`navigate_page`、`get_page_state`、`close_session`、`close_all_sessions` |
| `serve/daemon/bundled-packs.ts:101-122` `BundledKernelPacks` | 内核自带三个产品能力的 sidecar 桩：`velaros.agent`（`agent:execute`，0.3.2）、`velaros.model`（0.3.0）、`velaros.browser`（`browser:control`，0.3.0），版本号是字面量；`serve/main.ts:39` 无条件登记它们 |
| `runtime/host/sidecar-bridge.ts:508-513` | 「Desktop 共享 HostBridge socket」`~/.velaros/host-bridge.sock` |
| `serve/daemon/boot.ts:99-108` | 读 `VELAROS_HOST_BRIDGE_ENDPOINT` 自动挂 sidecar 适配器（带「离线桩」回退） |
| `serve/daemon/mod-store.ts:64-70`、`remote/client/credential-store.ts:43-48`、`client/contracts/descriptor.ts:33-40`、`serve/updater/layout.ts:26-57` | 数据位置各算各的：`~/.velaros/mods`、`~/.velaros/mod-index.json`、`~/.velaros/remote-nodes/<slug>.json`、`<tmpdir>/velaros-kernel-<uid>`、`…/VelarOS/kernel`（Linux 是 `…/velaros/kernel`） |
| `runtime/service/KernelService.ts` 2 处、`serve/rpc/local-rpc-server.ts` 5 处 | 报错文字写死「kernel protocol v2」 |
| `remote/module-projection.ts:25、35-36` | 代理模块 `apiVersion` 另抄一个 1（绕过 check:kernel-arch ⑧ 的字面量检查）；假定远端 id 都以 `velaros.` 开头 |
| 注释 | 多处引用 Desktop 仓的「宪章 §15.x」、「Mac / Windows 那一侧」、「Electron safeStorage」——只是注释，改造时改成本仓文档或删掉 |

HostBridge / sidecar 已在 Desktop（`docs/kernel-contract.md` §15.2「HostBridge 自进程退役」，`src/main/chat/ExecutionCoordinator.ts:108`）和本仓 `docs/mod-dev/capabilities.md:81`（「sidecar 只为旧 HostBridge 产物兼容，新 Mod 不得使用」）判退役，没有任何产品起 HostBridge 服务端。内核里这条链（`sidecar-bridge.ts` 514 行、`host-bridge.ts` 73 行、bundled 桩、boot 的两个选项、两个环境变量、6 个测试）是死代码，而且带着 D1、D2。

### 1.6 模块级可变状态

- 没有模块级 `let`；除日志外的模块级值只有 `serve/rpc/server-frames.ts` 的 `methodSet`（常量 `Set`）。
- 可执行入口 `serve/main.ts` 整个是顶层 await 脚本：读 5 个环境变量、建 ModStore、启守护进程、装信号处理，状态全在模块级常量里；`installKernelShutdownHandlers` 往 `process` 上挂 SIGINT / SIGTERM / SIGHUP。
- 闭包状态（按标准改成类）：`createScopedPermissionBroker`、`createNamespacedStateStore`、`KernelEventHub.forModule` 返回的对象字面量、`createKernelCallableCapability` 的操作表、`createRemoteNodeFileAuditLog` 的写队列（闭包里的 `let writing`）、`createRemoteNodeFileCredentialStore`、`createRemoteNodeProjection`（返回带闭包的对象）、常量函数 `nodeKernelFetch`。
- 进程级副作用：`KernelLauncher` 以 `detached: true` spawn 共享守护进程却不 `unref`；`defaultKernelRuntimeDirectory()` 在共享 `/tmp` 下建目录（D8）。

### 1.7 类、文件与数字

- **不实现接口的类 26 个**：`Kernel`、`KernelModuleHost`、`KernelCapabilityInvoker`、`KernelServiceStore`、`KernelEventHub`、`KernelHostBridgeRegistry`、`HostBridgeClient`、`KernelService`、`CapabilitySessionLedger`、`KernelIdentityRegistry`、`KernelClient`、`CapabilitySession`、`KernelLauncher`、`KernelLocalDaemon`、`KernelModLoader`、`KernelModStore`、`KernelLocalRpcServer`、`KernelUpdater`、`KernelUpdateLock`、`RemoteNodeClient`、`RemoteNodePendingCalls`、`RemoteNodeServer`、`RemoteNodeCallRunner`、`RemoteNodeInvocationPool`、`RemoteNodeResultCache`、`RemoteNodePairingGate`。实现了的 12 个都是注入面的缺省实现（两个权限/绑定缺省、状态后端、两个传输、隔离适配器、凭据存储、解包与验签缺省……）。
- **一个文件多个类的 12 个**：`runtime/capability-invocation.ts`（1 类 + 5 错误类）、`runtime/host/errors.ts`（3 错误类）、`runtime/host/service-registry.ts`（2）、`runtime/host/sidecar-bridge.ts`（2）、`runtime/service/KernelService.ts`、`runtime/service/identity-registry.ts`、`client/KernelLauncher.ts`、`serve/daemon/daemon.ts`（各 1 类 + 1 错误类）、`runtime/service/client-access.ts`（2）、`client/errors.ts`（2 错误类）、`serve/updater/errors.ts`（3 错误类）、`remote/node/call-runner.ts`（3）。
- **公开静态成员**：`KernelUpdateLock.acquire`。
- **函数** 205 个（导出 91 个）；实现文件里的模块级私有函数很多（`local-rpc-server.ts` 15 个、`socket-transport.ts` 10 个、`KernelService.ts` 7 个……），都要进 utils。
- **散落数字 30 处**（模块级数字常量 28、`?? 数字` 1、参数缺省 1）：启动等待 30000、轮询 100、RPC 帧上限 4 MiB（客户端、服务端各写一遍）、清单上限 8 MiB、保留版本 3、远程调用宽限 5000、缺省截止 120000、重连 500 / 30000 / 0.25 / 6、端口 43180–43190、并发 4、回放缓存 256、协议上限 7 个。

### 1.8 英文的用户 / 模型可见文字

门禁口径（`new XxxError(...)`、`super(...)`、`message:` 字段）157 条；另有 16 条走 `failure()` / `sessionFailure()` / `rpcFailure()` 的函数参数、门禁看不见，却正是 wire 上的 `error.message`（Termel 工具网关原样转出去）；权限理由与拒绝原因 17 条（进确认弹窗或拒绝回执）；`DOMException` 中止文字 5 条。合计约 190 条。明细、冗余与歧义见第 4 节。

### 1.9 测试怎么组织

`test/` 25 个文件 5,394 行：client 3（含假端点）、protocol 1、runtime 7（`host.test.ts` 816 行）、serve/daemon 7、serve/updater 7（含 support）；`package.json` 的 `test` 是 `bun test test`。import 混用包名自引用（24 处）与深相对路径（`../../../src/serve/updater` 等）。没有 `spec/`（不变量、验收）。**远程节点 17 个文件 2,478 行在本仓零测试**，只靠 Termel 仓的 `remote-node.e2e.test.ts` 跨仓覆盖。sidecar 的 6 个用例随 sidecar 删除。

## 2. 目标布局

### 2.1 总体

```text
packages/kernel/
  MODULE.md                       模块卡片（十节；吸收 README、docs/client.md、docs/serve.md）
  bin/velaros-kernel-daemon.mjs   ★ 可执行入口，在 src 之外：取 ./serve 的 kernelDaemonProcess，交进程环境与模块导入函数，三行
  spec/  invariants.md  acceptance.test.ts  support.ts
  test/                           实现测试：现有 23 个按新目录重排，新增 remote/
  src/
    contract/  provides.ts  requires.ts  constants.ts
    types/     kernel.ts（可移植）  runtime.ts  wire.ts  serve.ts  client.ts  updater.ts  remote.ts
    impl/      runtime/(14)  serve/(12)  client/(4)  updater/(5)  remote-client/(5)  remote-node/(7)
    utils/     tuning.ts  errors.ts  semver.ts  fs.ts
               runtime/(3)  wire/(7)  rpc/(3)  serve/(3)  updater/(7)  remote/(10)
    exports/   index.ts  contracts.ts  client.ts  serve.ts  remote.ts
    velaros-globals.d.ts          （.d.ts 不在门禁口径里，照 system 留在 src 根）
```

没有模型面工具：登记表不填 `toolsFile`、`toolDefiner`、`hostPort`（同 platform）；卡片「骨干链路」写每件能力怎么回答。impl 根上不放文件，只有 6 个域子目录，每个直接放 ≥3 个文件；不套 `remote/{client,node}` 这种只装子目录的空层（门禁 `checkSubdirectories` 会拦），所以是平铺的 `remote-client/`、`remote-node/`。

### 2.2 impl/：每个子目录放哪些类

标 ★ 的是新建的类（从闭包工厂、对象字面量、脚本改来）。括号里是类实现的接口：写「provides」「requires」的是公开接口，其余是类上方的包内接口。

| 子目录 | 类文件（接口）← 来源 |
| --- | --- |
| `runtime/`（14） | `Kernel`（`KernelApi`，provides；工厂 `createKernel`）← `runtime/Kernel.ts`；`KernelModuleHost`（`KernelModuleHostApi`）← `runtime/host/KernelModuleHost.ts`；`KernelCapabilityInvoker` ← `runtime/capability-invocation.ts`；`KernelServiceStore`、`ScopedKernelServiceResolver`（`KernelServiceResolver`，provides）← `runtime/host/service-registry.ts`；`KernelEventHub` ← `event-bus.ts`；★`ScopedKernelEventBus`（`KernelModuleEventBus`，provides）← `KernelEventHub.forModule` 的对象字面量；★`ScopedKernelPermissionBroker`（`KernelModulePermissionBroker`，provides）← `createScopedPermissionBroker`；`DenyAllKernelPermissionBroker`（`KernelPermissionBroker`，requires）；★`NamespacedKernelStateStore`（`KernelStateStore`，provides）← `createNamespacedStateStore`；`InMemoryKernelStateBackend`（`KernelStateBackend`，requires）；★`KernelCallableCapability`（`KernelCallableCapabilityService`，requires）← `createKernelCallableCapability` 的闭包；★`KernelModuleKit`（`KernelModuleKitApi`，provides，实例 `kernelModules`）← `createCapabilityToken`、`requireCapability`、`defineKernelModule`、`createKernelCallableCapability`；★`VelarosModEnvelopeParser`（`VelarosModEnvelopeApi`，provides，实例 `velarosModEnvelopes`）← `parseVelarosModEnvelope` |
| `serve/`（12） | `KernelService`（`KernelServiceApi`）← `runtime/service/KernelService.ts`；`CapabilitySessionLedger` ← `capability-grants.ts`；`DenyAllKernelClientAccessBroker`、`AllowLoadedKernelClientAccessBroker`（`KernelClientAccessBroker`，requires）← `client-access.ts`；`KernelLocalDaemon` ← `serve/daemon/daemon.ts`；`KernelLocalRpcServer` ← `serve/rpc/local-rpc-server.ts`；`KernelModStore`、`KernelModLoader` ← `serve/daemon/`；`InProcessKernelTransport`（`KernelClientTransport`，requires）← `serve/internal/`；★`KernelDaemonAssembly`（`BootedKernelDaemonApi`，provides，工厂 `bootKernelDaemon`）← `serve/daemon/boot.ts`；★`KernelDaemonProcess`（`KernelDaemonProcessApi`，provides，实例 `kernelDaemonProcess`）← `serve/main.ts` 与 `installKernelShutdownHandlers`；`KernelLauncher`（`KernelLauncherApi`，provides，工厂 `createKernelLauncher`）← `client/KernelLauncher.ts`（宪章 §15.3 把 launcher 划进 serve 部署组合；第 7 节 11） |
| `client/`（4） | `KernelClient`（`KernelClientApi`，provides）、`CapabilitySession`（`CapabilitySessionApi`，provides）、`SocketKernelTransport`（`KernelClientTransport`，requires）← `client/`；★`KernelDaemonDirectory`（`KernelDaemonDirectoryApi`，provides，实例 `kernelDaemons`）← `client/discovery.ts` 与 `client/contracts/descriptor.ts` 的路径函数 |
| `updater/`（5） | `KernelUpdater`（`KernelUpdaterApi`，provides，工厂 `createKernelUpdater`）；`KernelUpdateLock`（静态 `acquire` 改成本文件的工厂）；`PassthroughKernelArtifactExtractor`、`UnverifiedKernelArtifactSignatureVerifier`（requires 的两个扩展点）← `serve/updater/`；★`NodeKernelArtifactFetcher`（`KernelArtifactFetcher`，requires，原 `KernelFetch` 函数类型）← `nodeKernelFetch` |
| `remote-client/`（5） | `RemoteNodeClient`（`RemoteNodeClientApi`，provides，工厂 `createRemoteNodeClient`）、`RemoteNodePendingCalls`、`FileRemoteNodeCredentialStore`（`RemoteNodeClientCredentialStore`，requires，工厂 `createRemoteNodeClientCredentialStore`）← `remote/client/`；`RemoteNodeIsolationAdapter`（`KernelModuleIsolationAdapter`，requires，工厂 `createRemoteNodeIsolationAdapter`）← `remote/`；★`RemoteNodeProjection`（`RemoteNodeProjectionApi`，provides，工厂 `createRemoteNodeProjection`）← `remote/module-projection.ts` |
| `remote-node/`（7） | `RemoteNodeServer`（`RemoteNodeServerApi`，provides，工厂 `createRemoteNodeServer`）；`RemoteNodeCallRunner`、`RemoteNodeInvocationPool`、`RemoteNodeResultCache`（一个文件拆三个）；`RemoteNodePairingGate` ← `remote/node/`；★`FileRemoteNodeServerCredentialStore`（`RemoteNodeServerCredentialStore`，requires，工厂 `createRemoteNodeServerCredentialStore`）、★`FileRemoteNodeAuditLog`（`RemoteNodeAuditSink`，requires，工厂 `createRemoteNodeAuditLog`）← 两个闭包工厂 |

合计 47 个类文件（身份注册表若按第 7 节 3 保留则 48 个）。删掉的类：`HostBridgeClient`、`SidecarIsolationAdapter`、`KernelHostBridgeRegistry`（HostBridge 退役）；`KernelIdentityRegistry`（待定）。

**错误类 20 → 4，放 `utils/errors.ts`**。门禁允许「只有字段、写了中文说明的错误类」放 utils（utils 里的校验函数要抛它们，而 utils 不许引 impl；project 的 `ProjectError` 是先例）。都不出包，外面按码判断：

| 错误类（字段） | 收下的 |
| --- | --- |
| `KernelError`（`code`、`details`） | `KernelHostError`、`KernelStartupError`、`KernelOperationError`、5 个 `KernelCapability*Error`、`UnknownKernelCapabilityOperationError`、`KernelServiceLifecycleError`、`KernelIdentityRegistryError` |
| `KernelClientError`（`code`、`retryable`、`guidance`） | `KernelClientError`、`KernelRpcClientError`（两个 getter 改成字段）、`KernelLauncherError`、`KernelDaemonError`、`KernelRpcProtocolError` |
| `KernelUpdaterError`（`code`、`details`） | `KernelUpdaterError`、`KernelUpdateLockError`、`KernelArtifactVerificationError` |
| `RemoteNodeClientError`（`code`、`retryable`、`resultUnknown`、`nodeError`） | 原样 |

`details` 收下原来各子类的专属字段（`phase`、`rollbackErrors`、`failures`、`capabilityId`、`operation`、`permission`、`reason`……），Workbench 现在读的 `capabilityId`、`operation`、`permission` 都还在。

### 2.3 分层

| 层 | 登记（`layers`） | 说明 |
| --- | --- | --- |
| 1 进程侧装配 | `serve/` | 协议服务面、守护进程、本机 RPC、mod 仓库与装载、进程内传输、启动器 |
| 2 部署件 | `client/`、`updater/`、`remote-client/`、`remote-node/` | 瘦客户端、更新器、远程节点两端 |
| 3 进程内内核 | `runtime/` | 模块宿主、唯一调用路径、模块 SDK、mod 信封解析；不碰 Node 模块 |

按现有目录逐一查过跨目录引用（runtime、client、updater、remote/node、remote/client 各自不引别的切片；跨目录的只有 serve 引 runtime 与 client 契约、remote 根上两个文件经根入口引 runtime），按附录 A 归位后只有上层引下层：`serve/` 引 `runtime/`（宿主、调用器）与 `client/`（启动器用守护进程目录）；`remote-client/` 引 `runtime/`（`kernelModules.callable/token/define`）；`client/`、`updater/`、`remote-node/` 不引任何别的 impl 子目录。门禁的分层是线性的，表达不了「同层互不引用」「client 虽在 runtime 之上也不许引它」，这几条继续由 `check:kernel-arch` 按目录核（第 3 步改写它的路径）：

- `impl/runtime/`、`utils/runtime/` 不引 `serve/`、`client/`、`updater/`、`remote-*`（原防线③ runtime 一条）；
- `impl/client/` 不引 `runtime/`、`serve/`（原防线③ client 一条）；
- `impl/updater/`、`utils/updater/` 只引 `utils/{errors,semver,fs,tuning}`、types 与合同（原防线③ updater 一条，改造后它必然要引常量表里的错误码，规则从「不引 contracts」改成「不引别的切片」）；
- `remote-client/` 与 `remote-node/` 互不引用，两侧共用的只在 `utils/remote/`（`remote/node/index.ts` 注释里的约定，现在没有机械检查）；
- wire schema 只许定义在 `utils/wire/`（原防线④）；
- `KernelModuleHost` 只由 `impl/runtime/Kernel.ts` 与 `impl/serve/KernelDaemonAssembly.ts` 构造，这两处与 `impl/serve/KernelService.ts` 必须复用 `KernelCapabilityInvoker`（原防线⑧）。

utils 在所有层之下，谁都能用；它只引 utils、types 与合同。

### 2.4 utils/

| 位置 | 文件 ← 来源 |
| --- | --- |
| 根 | `tuning.ts` ★（`KernelTuning`，见 3.3 末尾）；`errors.ts` ★（4 个错误类与 `toError`）；`semver.ts`（三份合一：以更新器那份的预发布排序为准，宿主的 caret / tilde / `||` 语法、mod 信封的「可解析」判定都由它回答，`+build` 统一处理）；`fs.ts`（`isNodeError` 七份合一、`ignoreMissing`、`readJsonFile`、独占锁文件的获取与属主判活——守护进程锁和更新锁共用；原子写改用 core 的 `writeJsonFileAtomically`） |
| `runtime/`（3） | `manifest.ts`（`cloneManifest`、`validateManifest`）、`module-plan.ts`（`resolveKernelModulePlan` 与稳定拓扑序）、`callable.ts`（`normalizeMetadata`、`isKernelCallableCapabilityService`、`resolveKernelCapabilityOperationReason`） |
| `wire/`（7） | `capability.ts`、`handshake.ts`、`mods.ts`、`mod-envelope.ts`、`remote-node.ts`、`negotiation.ts`、`snapshot.ts`：全部 zod schema 与解析函数，schema 一律 `satisfies z.ZodType<手写类型>` 编译期对齐 |
| `rpc/`（3） | `descriptor.ts`（运行目录、守护进程路径、descriptor 解析）、`frames.ts`（服务端请求解码与失败帧、客户端响应与事件帧解码）、`endpoint.ts`（监听、关闭、清陈旧 socket、令牌常数时间比较） |
| `serve/`（3） | `service.ts`（descriptor 投影、失败信封、健康投影、作用域转换、会话覆盖判定）、`mod-index.ts`（索引读写、目录安装的清单解析、导出形状判定）、`mod-packs.ts`（`bundledModules` 折成 pack 记录、系统 pack JSON 解析） |
| `updater/`（7） | `layout.ts`、`manifest.ts`、`pointer.ts`、`installation.ts`、`download.ts`、`transport.ts`、`extraction.ts` |
| `remote/`（10） | `crypto.ts`（含配对码常数时间比较）、`frames.ts`、`manifest.ts`（修订号）、`close-policy.ts`、`handshake.ts`、`projection.ts`（slug、命名空间化、代理模块）、`listener.ts`、`ws-socket.ts`、`credentials.ts`（凭据文件 schema、缺省路径改用 `os.homedir()`）、`calls.ts`（截止时长、wire 作用域转换、错误描述） |

类里不用 `this` 的私有方法按标准一并进对应文件（门禁拦「私有方法没用到实例状态」）。

### 2.5 types/

| 文件 | 内容 |
| --- | --- |
| `kernel.ts`（**可移植**，`./contracts`；不 import、不带函数成员，只许从常量表 import type） | 公开签名用到的全部数据，约 150 个类型：ABI 数据（`CapabilityToken`、`CapabilityRequirement`、`ScopeRef`、`ResourceRef`、`KernelModuleManifest`、`KernelModuleStatus`、`KernelModuleHealth`、`KernelEvent`、`KernelPermissionRequest`、`KernelModulePermissionRequest`、`KernelPermissionDecision`、`Awaitable`）；快照（`KernelModuleSnapshot`、`KernelCompositionSnapshot`、`KernelStatus`）；wire 数据（`KernelHandshake`、`KernelModuleDescriptor`、`CapabilityCall*`、`CapabilitySession*`、`CapabilityRequireItem`、`KernelServiceHealth`、mods 请求与 pack 描述、mod 信封与诊断）；本机 RPC 数据（`KernelRpcEndpoint`、`KernelDaemonPaths`、`KernelDaemonEndpointDescriptor`）；远程节点公开数据（身份、清单、能力 / 操作 / 工具描述、错误、两侧凭据、审计行、活动事件、服务状态、调用入参与结果、`RemoteNodeFailure`）；更新器公开数据（清单、制品、指针、安装结果）；客户端绑定请求与判定 |
| `runtime.ts` | 带函数或宿主类型的运行时数据：`KernelCapabilityOperationMetadata`（`reason` 可以是函数）、`KernelCapabilityCall`（`AbortSignal`）、`KernelLifecycleFailure`；宿主内部记录（`ModuleRecord`、`KernelModulePlan`、`ServiceEntry`、`EventSubscription`、`KernelErrorDetails`） |
| `wire.ts` | 只在包内流动的 wire 形状：本机 RPC 请求 / 响应 / 事件帧、远程节点 14 种帧、协议判定结果、帧解码结果 |
| `serve.ts`、`client.ts`、`updater.ts`、`remote.ts` | 各域的工作类型：连接上下文、pack 记录、`KernelModCatalog`；在途请求；锁记录、取数请求与响应；在途调用、握手步骤、关闭动作、密钥对、监听选项 |

同名异义的四组类型改名：wire 形态（`kind: string | null`）叫 `KernelWireScopeRef`、`KernelWireResourceRef`、`KernelWireCapabilityToken`、`KernelWireCapabilityRequirement`，ABI 形态保留原名（能力包全用 ABI 形态）；`RemoteNodeCredentialStore` 两侧分成 `RemoteNodeClientCredentialStore`、`RemoteNodeServerCredentialStore`。`CapabilityToken` 的服务类型品牌原来靠 `declare const capabilityServiceType: unique symbol`（一条值声明，types 与合同文件都不许有），改成可选幽灵字段 `readonly serviceType?: TService`，运行时对象不变。

### 2.6 exports/：五个入口

| 入口 | 文件 | 给谁 | 运行环境 | 内容 | 为什么单独成入口 |
| --- | --- | --- | --- | --- | --- |
| `.` | `index.ts` | 八个能力包写模块；Desktop、Workbench 装进程内内核；memory 探针 | 任何环境（登记 `browserSafeEntries`） | 值：`createKernel`、`kernelModules`、`velarosModEnvelopes` 与全部常量表；类型：provides、requires、公开数据的全部——门禁规定每个公开接口都从根入口出，所以 client、serve、remote 的接口也在这里以类型出包（platform 根入口导出 `VelarOSSharedResourcesApi` 类型、值在 `./shared-resources` 是先例） | 标准入口 |
| `./contracts` | `contracts.ts` | agent 的浏览器面（`utils/wire/mods.ts` 要 `VelarosModManifestFileName`，`check:agent-browser` 打包核对）；任何进程拿 wire 数据 | 任何环境 | `export * from '../contract/constants.js'`、`export type * from '../types/kernel.js'` | 标准入口 |
| `./client` | `client.ts` | 附着到已运行守护进程的产品（Termel attached-host） | Node（`node:net`、`node:fs`） | `kernelDaemons` | 瘦客户端不许加载内核运行时与守护进程代码（宪章 §15.3「client 子路径收窄服务面」、防线③）；并进 `./serve` 会让只想附着的进程把运行时与守护进程整个求值一遍 |
| `./serve` | `serve.ts` | 自己起守护进程的宿主（Termel host）、可执行文件、启动或安装共享 Runtime 的产品 | Node | `bootKernelDaemon`、`kernelDaemonProcess`、`createKernelLauncher`、`createKernelUpdater` | 依赖 `node:net/fs/crypto/child_process`，不能进根入口；宪章 §15.3 把 daemon、RPC、launcher、updater 划为同一个可选部署组合 |
| `./remote` | `remote.ts` | agent 的远程工具与 MCP 桥（Client 侧）、Termel 的无头节点（Node 侧）、装配远程隔离的宿主 | Node + `ws` | `createRemoteNodeClient`、`createRemoteNodeServer`、`createRemoteNodeProjection`、`createRemoteNodeIsolationAdapter`、三个文件存储工厂 | 独有第三方依赖 `ws` 与 `node:http`，进程内宿主不该为此加载它们；两侧消费方不同但依赖闭包相同，合成一个入口 |

删掉的七个：`./contracts/abi`、`./contracts/protocol`、`./runtime`（并入 `.`）、`./client/contracts`（数据进 `.` 与 `./contracts`）、`./serve/updater`（并入 `./serve`）、`./remote/client`、`./remote/node`（并入 `./remote`）。入口名不带 `/` 是门禁的硬约束（入口名映射成 `exports/<名>.ts`，`exports/` 不许分包），`./contracts/abi` 这类名字没有办法保住。

`browserSafeEntries: ['index.ts', 'contracts.ts']`。根入口做得到不碰 Node 模块的前提：删掉 sidecar（`node:net`）；能力会话账本随 `KernelService` 去 `serve/`（`node:crypto`，顺手改 `globalThis.crypto.randomUUID()`）；其余运行时只依赖 core 根与 zod。

### 2.7 不变量草案（第 7 步落 `spec/invariants.md`）

| 编号 | 不变量 | 检验 |
| --- | --- | --- |
| INV-1 | 没注入权限策略时，任何声明了权限的操作一律拒绝 | 测试 |
| INV-2 | 未知操作在求权限之前就拒绝，不论服务来自进程内模块还是隔离适配器 | 测试 |
| INV-3 | 声明的每一条权限都在 provider 代码运行前逐条判定，一条拒绝就不调用 | 测试 |
| INV-4 | 模块只能解析自己声明过的能力（provides / requires / optionalRequires） | 测试 |
| INV-5 | 模块不能冒充模块 id、代数或调用方 | 测试 |
| INV-6 | 替换模块失败不影响现有代；替换成功后旧代句柄立即失效 | 测试 |
| INV-7 | 一个事件订阅者失败不影响其他订阅者与发布方 | 测试 |
| INV-8 | 组合快照只读、确定、冻结，降级态也给得出 | 测试 |
| INV-9 | 进程内与 serve 共用一条调用路径 | 门禁 `check:kernel-arch` |
| INV-10 | wire schema 与已审快照一致 | 门禁 `check:kernel-schemas` |
| INV-11 | 根入口与 `./contracts` 的引用链不碰 Node 模块 | 门禁 `check:module-ownership` |
| INV-12 | client 不引 runtime / serve，updater 不引别的切片，remote 两侧互不引用 | 门禁 `check:kernel-arch` |
| INV-13 | 协议只接受完全相同的版本，异版本给出升级方向 | 测试 |
| INV-14 | 能力会话之外的调用一律 `CAPABILITY_NOT_GRANTED`，会话不跨连接 | 测试 |
| INV-15 | 本机 RPC：令牌常数时间比较；descriptor 0600、运行目录 0700 且属主是自己 | 测试 |
| INV-16 | 单实例锁与更新锁：活着的持有者不会被抢 | 测试 |
| INV-17 | 远程节点：签名通过前收到的调用一律断开 | 测试 |
| INV-18 | 远程节点：一个 callId 恰好一帧终态，重连后同一 callId 回放已有结果 | 测试 |
| INV-19 | 远程节点：对端重启后在途调用按「结果未知」上抛 | 测试 |
| INV-20 | 配对码常数时间比较、失败锁定，重开窗口不清零 | 测试 |
| INV-21 | 更新器：大小与 SHA-256 核对通过才落位，安装经原子改名，健康检查失败回滚指针 | 测试 |
| INV-22 | 模块 API 版本、协议版本只从常量表引用，不复制数字 | 门禁 `check:kernel-arch` |
| INV-23 | `KernelModulePermissionRequest` 没有 `callerModuleId` 字段 | 类型 `src/types/kernel.ts::KernelModulePermissionRequest` |

## 3. 合同草案

原则同 ADR 0003 / 0007：外面拿到的是整件能力；类实现的 API 写在类上方、`provides.ts` 用 `export type { X } from '../impl/<域>/<类>.js'` 登记，没有类的公开接口直接声明在 `provides.ts`；出包的值只有常量表、按公开接口标注类型的实例与工厂；类、utils 函数、错误类不出包，外面按错误码判断。成员按真实消费方收窄，每行写了证据。

### 3.1 `contract/provides.ts`：产品面

**A. 进程内内核与模块 SDK（`.`）**

| 接口 | 实现 | 出包的值 | 成员 | 谁在用 / 说明 |
| --- | --- | --- | --- | --- |
| `KernelApi` | `runtime/Kernel`（登记） | 工厂 `createKernel(options?: KernelOptions): KernelApi` | 13：`version`、`getStatus`、`registerModule`、`start`、`dispose`、`listModules`、`describeComposition`、`hasCapability`、`getCapability`、`resolveCallableCapability`、`requestCapabilityPermission`、`invokeCapability`、`subscribeEvent` | Desktop `Composition.ts`、`Services.ts`、`kernelAssembly.mjs`；Workbench `index.ts`、`kernelHostProbe.ts`、`WorkbenchKernelIpc.ts`；memory 探针。删 `registerModules`（零外部调用）。`invokeCapability` 的调用描述加宿主专用的 `attribution`（第 7 节 5） |
| `KernelModuleKitApi` | `runtime/KernelModuleKit`（登记） | 实例 `kernelModules` | 4：`token(id, version?)`、`requirement(token, range?)`、`define(module)`、`callable(operations)` | 八个能力包与 Desktop `mainRegistry`：`token` 14 处、`define` 14、`callable` 10；`requirement` 零调用但写在 `docs/mod-dev/capabilities.md`，保留。做成实例方法而不是顶层泛型函数：门禁按登记接口求公开面闭包，方法上的类型参数不会被当成 impl 引用；顶层泛型工厂的类型参数会被报「公开面引用 impl」 |
| `VelarosModEnvelopeApi` | `runtime/VelarosModEnvelopeParser`（登记） | 实例 `velarosModEnvelopes` | 1：`parse(input, { origin? })` | agent 2 个文件、Desktop 3 个、Termel 1、`scripts/mod/velaros-mod.mjs` |
| `KernelModuleActivateContext` | 宿主给模块的对象（直接声明） | — | 8：`moduleId`、`generation`、`signal`、`services`、`events`、`permissions`、`state`、`registerService` | 八个能力包的内核模块与测试 |
| `KernelServiceResolver` | `runtime/ScopedKernelServiceResolver`（登记） | — | 4：`has`、`get`、`getHandle`、`getOptional` | 激活上下文的 `services` |
| `KernelServiceHandle`、`KernelRegistration` | 直接声明（对象字面量） | — | 6 / 1 | |
| `KernelModuleEventBus` | `runtime/ScopedKernelEventBus`（登记） | — | 2：`publish`、`subscribe` | |
| `KernelModulePermissionBroker` | `runtime/ScopedKernelPermissionBroker`（登记） | — | 1：`request` | |
| `KernelStateStore` | `runtime/NamespacedKernelStateStore`（登记） | — | 4：`get`、`set`、`delete`、`list` | Desktop `mainRegistry` |

**B. serve 部署组合（`./serve`）**

| 接口 | 实现 | 出包的值 | 成员 | 说明 |
| --- | --- | --- | --- | --- |
| `BootedKernelDaemonApi` | `serve/KernelDaemonAssembly`（登记） | 工厂 `bootKernelDaemon(options): Promise<BootedKernelDaemonApi>` | 5：`descriptor()`、`handshake()`、`modLoadFailures`、`createClient()`、`stop()` | Termel `host.ts` 现在用 `booted.service.handshake()`、`booted.daemon.getDescriptor()`、`new KernelClient(new InProcessKernelTransport(booted.service))`，换成前四个成员；`KernelService`、`KernelLocalDaemon`、`InProcessKernelTransport` 不再出包 |
| `KernelDaemonProcessApi` | `serve/KernelDaemonProcess`（登记） | 实例 `kernelDaemonProcess` | 1：`run({ environment, importModule })` | 只给 `bin/velaros-kernel-daemon.mjs`；读环境变量表里的 4 个变量、装信号处理 |
| `KernelLauncherApi` | `serve/KernelLauncher`（登记） | 工厂 `createKernelLauncher(options)` | 6：`isRunning`、`ensureRunning`、`verifyHealthy`、`stop`、`restart`、`dispose`（`getDescriptor` 并进 `kernelDaemons.discover`） | 零消费，按宪章 §15.3 保留为 serve 部署件 |
| `KernelUpdaterApi` | `updater/KernelUpdater`（登记） | 工厂 `createKernelUpdater(options)` | 11：`getLayout`、`getArtifactTarget`、`getActivePointer`、`getActiveVersion`、`listInstalledVersions`、`loadManifest`、`ensureInstalled`、`ensureCompatible`、`activateVersion`、`rollback`、`pruneVersions` | 零消费；去留见第 7 节 8 |

**C. 瘦客户端（`./client`）**

| 接口 | 实现 | 出包的值 | 成员 | 说明 |
| --- | --- | --- | --- | --- |
| `KernelDaemonDirectoryApi` | `client/KernelDaemonDirectory`（登记） | 实例 `kernelDaemons` | 3：`defaultPaths(name?)`、`discover(paths?)`、`connect(paths?)` | Termel attached-host 的 `connectToKernelDaemon(paths)` |
| `KernelClientApi` | `client/KernelClient`（登记） | 经 `kernelDaemons.connect()` 或 `booted.createClient()` 取得 | 8：`handshake`、`health`、`openCapabilitySession`、`listMods`、`setModEnabled`、`installModFromDirectory`、`subscribe`、`dispose` | Termel 只用 `openCapabilitySession`、`dispose`；mods 三个零调用，但 `docs/agent/agent-mod-trunk.md` 的设计依赖 `mods/list`（第 7 节 4） |
| `CapabilitySessionApi` | `client/CapabilitySession`（登记） | — | 4：`sessionId`、`requires`、`call`、`dispose` | Termel tool-gateway |
| `ConnectedKernelDaemon` | 直接声明 | — | 3：`client`、`descriptor`、`handshake` | |
| `KernelEventSubscription` | 直接声明 | — | 1：`dispose` | |

**D. 远程节点（`./remote`）**

| 接口 | 实现 | 出包的值 | 成员 | 说明 |
| --- | --- | --- | --- | --- |
| `RemoteNodeClientApi` | `remote-client/RemoteNodeClient`（登记） | 工厂 `createRemoteNodeClient(options)` | 9：`connectionState`、`currentSession`、`stopReason`、`connect`、`invoke`、`onManifestChanged`、`onStateChanged`、`onStopped`、`dispose` | agent `RemoteHostService`、`RemoteNodeMcpServer`、`stdio-entry`，Termel e2e；隔离适配器读前三个 |
| `RemoteNodeServerApi` | `remote-node/RemoteNodeServer`（登记） | 工厂 `createRemoteNodeServer(options)` | 5：`start`、`startPairing`、`unpair`、`getStatus`、`stop` | Termel `remote-node.ts` 五个全用 |
| `RemoteNodeProjectionApi` | `remote-client/RemoteNodeProjection`（登记） | 工厂 `createRemoteNodeProjection(input)` | 8：`hostName`、`hostSlug`、`revision`、`modules`、`capabilities`、`tools`、`resolveBinding`、`resolveTool` | 装配顺序现在写在 `remote/client/index.ts` 的注释里，搬进卡片 |
| （requires 的 `KernelModuleIsolationAdapter`） | `remote-client/RemoteNodeIsolationAdapter` | 工厂 `createRemoteNodeIsolationAdapter(options)` | — | |
| （requires 的三个存储接口） | 三个文件存储 | 工厂 `createRemoteNodeClientCredentialStore({ hostSlug, path? })`、`createRemoteNodeServerCredentialStore(path)`、`createRemoteNodeAuditLog({ directory })` | — | 取代 `FileRemoteNodeCredentialStore` + `defaultRemoteNodeCredentialsPath`（agent stdio-entry）、`createRemoteNodeFileCredentialStore`、`createRemoteNodeFileAuditLog`（Termel） |

合计 provides 22 个接口，出包的值 15 个（`createKernel`、`kernelModules`、`velarosModEnvelopes`；`bootKernelDaemon`、`kernelDaemonProcess`、`createKernelLauncher`、`createKernelUpdater`；`kernelDaemons`；`createRemoteNodeClient`、`createRemoteNodeServer`、`createRemoteNodeProjection`、`createRemoteNodeIsolationAdapter` 与三个存储工厂），另加常量表。

### 3.2 `contract/requires.ts`：注入面

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `KernelOptions`（`permissionBroker?`、`stateBackend?`、`isolationAdapters?`、`kernelVersion?`、`lifecycleFailureMode?`、`onLifecycleFailure?`） | 否 | 宿主调 `createKernel` 时给。删掉 `apiVersion` 覆盖口（只有测试用，模块 API 版本只认常量表） |
| `KernelModuleDefinition`、`KernelModuleLifecycle` | 是 | 能力包提供模块，激活后返回生命周期钩子 |
| `KernelCallableCapabilityService`、`KernelCallableCapabilityOperation` | 按需 | 模块登记的可调用服务（`kernelModules.callable` 产出同形对象） |
| `KernelPermissionBroker` | 否（缺省全拒） | 宿主的权限裁决；Desktop、Workbench、Termel 各有实现 |
| `KernelStateBackend` | 否（缺省内存） | 宿主的模块状态持久化（Desktop `DesktopKernelStateBackend`） |
| `KernelModuleIsolationAdapter` | 按需 | 非进程内模块的激活（远程节点适配器是其一） |
| `KernelEventHandler` | — | 订阅回调 |
| `BootKernelDaemonOptions`（`kernelVersion`、`modules?`、`bundledModules?`、`modsRoot?`、`paths?`、`permissionBroker?`、`clientAccessBroker?`、`isolationAdapters?`、`importModule?`） | 是 | 起守护进程的宿主。删 `hostBridges`、`hostBridgeEndpoint`、`apiVersion`；`modStorePaths` 与三个 bundled 辅助函数换成 `modsRoot` 与 `bundledModules` |
| `KernelClientAccessBroker` | 否（有模块时缺省「已装载即可绑」，否则全拒） | 守护进程宿主决定哪个客户端能绑定哪个能力 |
| `KernelModuleImporter` ★ | 装第三方 pack 时必须 | 可执行文件交 `(url) => import(url)`；包内不再有动态 import |
| `KernelClientTransport` | 包内两个实现 | 进程内与 socket 两个类都实现它，按门禁必须写进合同；不再作为产品 API 宣传 |
| `KernelLauncherOptions`、`KernelVersionResolver` | 用启动器时 | 给 spawn 入口；删 `now`、`sleep` 两个测试钩子，保留 `spawnProcess`（Electron 宿主可能要自定义 spawn） |
| `KernelUpdaterOptions`、`KernelArtifactFetcher`、`KernelArtifactExtractor`、`KernelArtifactSignatureVerifier`、`KernelHealthCheck` | 用更新器时 | 取数、解包、验签三个扩展点；`KernelFetch` 函数类型改成带 `fetch()` 方法的接口 |
| `RemoteNodeClientOptions`、`RemoteNodeSocket`、`RemoteNodeSocketFactory`、`RemoteNodeClientCredentialStore` | 用远程 Client 时 | |
| `RemoteNodeServerOptions`、`RemoteNodeCapabilityInvoker`、`RemoteNodeManifestSource`、`RemoteNodeServerCredentialStore`、`RemoteNodeAuditSink`、`RemoteNodeActivitySink` | 起远程节点时 | `RemoteNodeManifestSource.current()` 改为只交 `{ capabilities, tools }`，修订号由服务端用唯一算法算（Termel 不再调 `createManifest`，第 7 节 12） |
| `RemoteNodeIsolationAdapterOptions` | 用远程隔离时 | |
| 环境变量（`KernelEnvironmentVariables`） | 否 | 见 3.3 |

### 3.3 `contract/constants.ts`：常量表

| 常量 | 内容 | 来源 |
| --- | --- | --- |
| `KernelVersionAxes` | `kernel: '0.3.0'`、`moduleApi: 1`、`protocol: 2`、`remoteNodeTransport: 1`，四根独立演进的轴 | `KernelVersion`、`KernelModuleApiVersion`、`KernelProtocolVersion`、`RemoteNodeProtocolVersion`。常量表只许冻结表与字符串身份，数字版本要进表（同 project 的 `ProjectToolContract.inputVersion`） |
| `KernelModuleIsolations` | `in-process`、`worker`、`remote`（`sidecar` 待定，第 7 节 2） | `KernelModuleIsolationValues`、wire 的 `CapabilityIsolationSchema`、mod 信封里的第三份字面量合一 |
| `VelarosModManifestFileName` | `'velaros.mod.json'` | 原样 |
| `KernelErrorCodes` | 宿主 17 个码 + `KERNEL_NOT_STARTED`，每个一句中文 | `KernelHostErrorCode` 与服务生命周期错误 |
| `KernelCallErrorCodes` | 进程内抛出的调用错误与 wire 失败信封共用一张表：`INVALID_REQUEST`、`KERNEL_NOT_STARTED`、`CAPABILITY_NOT_FOUND`、`CAPABILITY_NOT_AVAILABLE`、`CAPABILITY_NOT_CALLABLE`、`CAPABILITY_NOT_GRANTED`、`CAPABILITY_BIND_DENIED`、`CAPABILITY_BIND_FAILED`、`OPERATION_NOT_FOUND`、`OPERATION_METADATA_FAILED`、`PERMISSION_DENIED`、`PERMISSION_CHECK_FAILED`、`CALL_ABORTED`、`CAPABILITY_CALL_FAILED` | 现在是 `KernelService`、RPC 服务端、进程内传输里的字面量；声明了没人引用的 `KernelCapabilityGrantErrorCodes` 删掉；5 个进程内调用错误类原来没有码，改用这张表里同一情况的码 |
| `KernelClientErrorCodes` | 传输 5（`TRANSPORT_CLOSED`、`TRANSPORT_WRITE_FAILED`、`TRANSPORT_CONNECT_FAILED`、`TRANSPORT_DISCONNECTED`、`INVALID_RESPONSE`）、守护进程 5（`DAEMON_*`、`PROTOCOL_VERSION_MISMATCH`）、启动器 4（删从未抛出的 `KERNEL_BINARY_MISSING`）、RPC 协议 8、`MODS_UNAVAILABLE` | |
| `KernelUpdaterErrorCodes` | 17 个 | `KernelUpdaterErrorCode` |
| `RemoteNodeErrorCodes` | Client 侧 9 个 + wire 帧里的 10 个（`FRAME_INVALID`、`UNAUTHORIZED`、`PAIRING_FAILED`、`PROTOCOL_MISMATCH`、`DEADLINE_EXCEEDED`、`CALL_FAILED`、`CALL_ABORTED`、`DENIED`、`MANIFEST_STALE`、`NODE_STOPPED`） | `RemoteNodeClientErrorCodes` + 字面量 |
| `RemoteNodeCloseCodes` | 4001–4004 | `RemoteNodeCloseCode` |
| `RemoteNodeLimits` | 单帧 32 MiB、配对码有效期 5 分钟、失败 5 次锁 30 秒、心跳 15 秒、空闲 60 秒、缺省端口区间 43180–43190 | 两端共同遵守的协议数字；端口是用户连另一台机器时要知道的地址，算对外承诺 |
| `RemoteNodeSocketPath`、`RemoteNodeProgressEventType` | `'/v1/remote-node/ws'`、`'remote-node.progress'` | 原样 |
| `KernelRpcLimits` | 单帧 4 MiB | 客户端与服务端各写过一遍 |
| `KernelRpcMethods` | 19 个（删身份注册后 11 个） | 原样 |
| `KernelUpdateArtifactTargets`、`KernelUpdateArtifactFormats` | 6 个平台架构组合、4 种格式 | 更新清单格式的一部分 |
| `KernelEnvironmentVariables` | `VELAROS_KERNEL_RUNTIME_DIR`、`VELAROS_KERNEL_HOME`（input，任何宿主）；`VELAROS_KERNEL_VERSION`、`VELAROS_KERNEL_USER_MODS`、`VELAROS_KERNEL_INSTALL_PACK`、`VELAROS_KERNEL_SYSTEM_PACKS`（input，只给可执行文件） | 删 `VELAROS_HOST_BRIDGE_ENDPOINT`、`VELAROS_KERNEL_AUTO_SYSTEM_PACKS`（随 sidecar 桩一起没了意义）。`HOME`、`LOCALAPPDATA`、`XDG_DATA_HOME`、`USERNAME` 不再直接读：家目录用 `os.homedir()`，数据根交给 `@velaros-ai/platform`（第 7 节 10） |

`utils/tuning.ts` 的 `KernelTuning`（每项有人用、一句说明）：`launcher`（启动等待 30 秒、轮询 100 ms，另加 D20 要的停机宽限）、`updater`（保留版本 3、清单上限 8 MiB）、`remoteClient`（截止宽限 5 秒、缺省截止 120 秒、重连首跳 500 ms、上限 30 秒、抖动 0.25、指数上限 6）、`remoteNode`（并发 4、回放缓存 256）。凭据文件的 0600 / 0700、WebSocket 关闭原因 100 字节是格式数字，就地写或进类的 `private static readonly`。

### 3.4 要删的现有导出与替代

**真被用到的 59 个名字**：

| 现在 | 以后 |
| --- | --- |
| `./contracts/abi` 的 13 个类型（`CapabilityToken`、`KernelCallableCapabilityOperation`、`KernelCallableCapabilityService`、`KernelCapabilityOperationMetadata`、`KernelEvent`、`KernelModuleActivateContext`、`KernelModuleDefinition`、`KernelModuleHealth`、`KernelPermissionBroker`、`KernelPermissionDecision`、`KernelPermissionRequest`、`KernelStateStore`、`ScopeRef`） | 同名，从 `@velaros-ai/kernel` 取 |
| `KernelModuleApiVersion` | `KernelVersionAxes.moduleApi` |
| `createCapabilityToken(id, v)` / `defineKernelModule(m)` / `createKernelCallableCapability(ops)` | `kernelModules.token(id, v)` / `.define(m)` / `.callable(ops)` |
| `UnknownKernelCapabilityOperationError`（Workbench `instanceof`） | `error.code === KernelCallErrorCodes.operationNotFound` |
| `./contracts/protocol` 的 `CapabilityCallResponse`、`KernelModuleDescriptor`、`RemoteNodeCapabilityDescriptor`、`RemoteNodeManifest`、`RemoteNodeToolDescriptor` | 同名，从根入口或 `./contracts` 取 |
| wire 的 `ScopeRef`（Termel tool-gateway） | `KernelWireScopeRef` |
| `VelarosModManifestFileName` | 同名（常量表） |
| `parseVelarosModEnvelope(x, o)` | `velarosModEnvelopes.parse(x, o)` |
| `./runtime` 的 `Kernel`（`new Kernel(o)`；类型位） | `createKernel(o)`；类型 `KernelApi` |
| `KernelCapabilityPermissionDeniedError`、`KernelCapabilityUnavailableError`（Workbench `instanceof`） | 按 `KernelCallErrorCodes.permissionDenied`、`.capabilityNotFound` 判断，`capabilityId` / `operation` / `permission` 在 `error.details` |
| `KernelModuleHost`（memory 探针与测试） | `createKernel()`；memory 的 `MemoryStoreCapabilityRegistry.getOptionalService` 由 `kernel.getCapability` 适配 |
| `KernelStateBackend` | 同名 |
| `./client` 的 `KernelClient`、`CapabilitySession`（类型） | `KernelClientApi`、`CapabilitySessionApi` |
| `KernelProtocolVersion` | `KernelVersionAxes.protocol` |
| `connectToKernelDaemon(paths)` | `kernelDaemons.connect(paths)` |
| `./client/contracts` 的 `KernelDaemonPaths`、`KernelRpcEndpoint` | 同名，根入口 |
| `./serve` 的 `bootKernelDaemon` | 同名；`modStorePaths: createDefaultKernelModStorePaths(root)` → `modsRoot: root` |
| `BootedKernelDaemon` | `BootedKernelDaemonApi`：`booted.service.handshake()` → `booted.handshake()`、`booted.daemon.getDescriptor()` → `booted.descriptor()` |
| `InProcessKernelTransport` | `booted.createClient()` |
| `createDefaultKernelModStorePaths` | 选项 `modsRoot` |
| `./remote` 的 `createManifest` | 删；`RemoteNodeManifestSource.current()` 只交能力与工具 |
| `./remote/client` 的 `RemoteNodeClient`（`new`；类型） | `createRemoteNodeClient(o)`；`RemoteNodeClientApi` |
| `RemoteNodeClientError`（agent 3 处 `instanceof`） | 按 `RemoteNodeErrorCodes` 判断；`resultUnknown`、`retryable`、`nodeError` 照旧挂在错误对象上，形状是公开数据 `RemoteNodeFailure` |
| `FileRemoteNodeCredentialStore` + `defaultRemoteNodeCredentialsPath` | `createRemoteNodeClientCredentialStore({ hostSlug })` |
| `RemoteNodeCredentialStore`（Client 侧类型）/ `RemoteNodeCredentials` | `RemoteNodeClientCredentialStore` / 同名 |
| `./remote/node` 的 `RemoteNodeServer` | `createRemoteNodeServer(o)` |
| `createRemoteNodeFileAuditLog` / `createRemoteNodeFileCredentialStore` | `createRemoteNodeAuditLog` / `createRemoteNodeServerCredentialStore` |
| `RemoteNodeCredentialStore`（Node 侧类型） | `RemoteNodeServerCredentialStore` |
| `RemoteNodeActivityEvent`、`RemoteNodeAuditSink`、`RemoteNodeCapabilityInvokeRequest`、`RemoteNodeCapabilityInvokeResult`、`RemoteNodeCapabilityInvoker`、`RemoteNodeManifestSource`（形状变）、`RemoteNodePairedCredential` | 同名 |

**没人用、不再出包的约 290 个声明**：67 个 zod schema 与 `KernelProtocolWireSchemas`；协议判定 `negotiateKernelProtocol`、`isKernelProtocolAccepted`；全部 37 个类（宿主、服务登记表、事件总线、服务面、会话账本、身份注册表、两个缺省策略、sidecar 三件、传输、守护进程、RPC 服务、ModStore / Loader、更新器零件、远程两端的内部类）与 20 个错误类（改按码）；宿主零件函数（`validateManifest`、`resolveKernelModulePlan`、`createScopedPermissionBroker`、`createNamespacedStateStore`、`satisfiesVersionRange`、`assertSemanticVersion`、`toError`……）；`KernelAbi`、`KernelProtocol` 两个命名空间；serve 的 16 个零件函数（bundled 辅助、索引读写、RPC 帧辅助、`createDefaultKernelRpcEndpoint`、`installKernelShutdownHandlers`……）；更新器的 27 个函数与 16 个常量（只留 `createKernelUpdater` 与它签名里的数据）；远程节点的密钥 / 帧 / 握手 / 关闭码 / 退避函数、`RemoteNodeModuleApiVersion`、`RemoteNodeModuleVersion`、5 个调优常量、`RemoteNodeCompletedCallCapacity`。其余按上表改名或并进常量表。

### 3.5 与标准冲突、要处理的地方

1. **zod 先行的 wire 类型 vs「types 零值」** → 照 agent 的定案：类型手写进 `types/`，schema 留 `utils/wire/` 并 `satisfies z.ZodType<T>`；`check:kernel-schemas` 逐字节核对 schema 没变。
2. **可移植文件只能一个** → `types/kernel.ts` 约 150 个类型、估计 900 行（system 的 `system.ts` 640 行）。只在包内流动的帧放 `types/wire.ts`：门禁要求可移植文件里没有公开接口用不到的类型。
3. **入口名不能带 `/`** → 12 个入口收成 5 个（2.6）。
4. **禁动态 import vs 装第三方 pack** → 导入函数改成注入面 `KernelModuleImporter`，由 `bin/` 下的可执行文件（src 之外，不在门禁口径里）交进来。
5. **顶层 await 的可执行脚本在五目录里没有位置** → 逻辑进 `impl/serve/KernelDaemonProcess.ts`，入口文件搬到 `bin/`；`package.json` 的 `bin` 与 `files` 跟着改，`bun.lock` 的 bin 路径跟着变。
6. **`unique symbol` 品牌要一条值声明** → 改可选幽灵字段（2.5）。
7. **类不出包 vs 宪章 §15.2 / §15.6 与 README 写的「公共 `new Kernel()`」** → `createKernel()`，同 ADR 0005 把 `new SystemPlatformCompatibility()` 改 `createPlatform()` 的先例；文档跟改（第 7 节 1）。
8. **错误类不出包 vs Workbench / agent 靠 `instanceof`** → 先给错误补码（5 个进程内调用错误原来没有码），再收口。
9. **公开静态 `KernelUpdateLock.acquire`** → 同文件工厂。
10. **线性分层表达不了互斥** → client / runtime、remote 两侧、updater 独立这几条保留在 `check:kernel-arch`（2.3）。
11. **门禁不用改**：SDK 做成实例方法（3.1 A），没有顶层泛型工厂；没有工具文件与宿主端口，按 platform 的登记方式。

## 4. 模型面与用户面的文字

内核没有模型面工具，但它的报错、权限理由、拒绝原因会经宿主走到用户和模型面前。约 190 条全是英文。

### 4.1 谁看得到

| 去向 | 文字来源 | 例子 |
| --- | --- | --- |
| 权限确认弹窗的「理由」 | 调用器的缺省理由、远程适配器的理由 | `Invoke "${op}" on capability "${cap}".`（`runtime/capability-invocation.ts:150`）、`Run "${op}" on ${hostLabel}.` 与缺省主机名 `the remote host`（`remote/RemoteNodeIsolationAdapter.ts:105-114`） |
| 拒绝回执（成为 `KernelCapabilityPermissionDeniedError.message`，经 agent 工具结果到模型，经 Workbench 到界面） | 宿主与缺省策略的拒绝原因 | `Permission "p" is denied by the host default`、`Module "m" did not declare permission "p"`（宿主与模块视图各写一遍）、`Capability "c" has no active provider`（`Kernel.ts:164`、`KernelModuleHost.ts:508` 各一遍） |
| wire 失败信封的 `error.message`（Termel 工具网关转给插件桥与远程调用方，最后到模型） | `KernelService`、RPC 服务端、进程内传输 | 16 条，门禁看不见（走函数参数）：`Capability call request does not match kernel protocol v2`、`Capability "x" is not available`、`Operation "x" is not available`、`Capability call permission was denied`、`Kernel RPC authentication failed`、`Capability "x" is not bound on session "s"`…… |
| 远程调用失败（agent 远程工具回执；agent 只把 `resultUnknown` 与 `nodeError` 两种包成了中文） | Client 侧错误、Node 侧终态 | `Remote node restarted while "x" was in flight; the result is unknown`、`Remote node call "x" exceeded the client deadline`、`Call exceeded its ${ms}ms deadline`、`Call was cancelled by the client`、`Call carried manifest revision …`、`Remote node requires pairing; supply a 6-digit pairing code` |
| 模块状态（Workbench 把 `module.error` 投到渲染进程状态） | 宿主错误 | `Module "m" requires missing capability "c"`、`Kernel module "m" failed during activate`、`Capability "c" from module "m" at 1.0.0 does not satisfy ^2.0.0` |
| mod 安装诊断（Desktop、Termel、`bun run mod`） | 信封解析 | zod 默认的英文 issue 和自写中文（「module 节的 id…与 agent 节的 id…不一致」「不是合法的 x.y.z 版本号」）混在同一张诊断表里 |
| 命令行与宿主日志 | 启动器、守护进程、更新器 | 约 60 条（`Kernel did not publish an endpoint within ${ms}ms`、`Kernel update manifest is invalid: …`……） |

### 4.2 冗余与歧义

- **同一件事三个码、五种说法**：「能力没有活动提供者」进程内抛无码错误 `has no active provider`，会话打开时回 `CAPABILITY_NOT_AVAILABLE`「is not loaded」，调用时回 `CAPABILITY_NOT_FOUND`「is not available」，绑定策略说「is not provided by any loaded module」。建议合同里 `CAPABILITY_NOT_AVAILABLE` 与 `CAPABILITY_NOT_FOUND` 二选一（wire 变化，第 7 节 7），中文统一成一句。
- **「kernel protocol v2」写死在 7 条报错里**（`KernelService.ts` 2 条、`local-rpc-server.ts` 5 条），协议一升级就说错话；改成引用 `KernelVersionAxes.protocol`。
- **同一次拒绝两条路径说法不同**：serve 路径的 `PERMISSION_DENIED` 一律「Capability call permission was denied」、`details: null`，宿主给的拒绝原因丢了；进程内路径的错误消息就是那条原因（D16）。
- **「Kernel service is not started」在启动已经失败之后仍标可重试**（D13）。
- **声明了从不产生的码**：`KERNEL_BINARY_MISSING`；`DAEMON_ALREADY_RUNNING` 写在客户端的码联合里，实际由守护进程的另一个错误类抛出；`KernelCapabilityGrantErrorCodes` 表没有人引用，同样的字符串在别处手写。
- **错误名是英文类名**（`name` 字段），Workbench 的状态会露出来；收成 4 个类后名字也少了。

### 4.3 改法

全部改中文，命令、路径、错误码、字段名、版本号照原样夹在中文里；外面判断失败一律按码（3.3 的表），文字不再是契约（同 system 在 09-15 20:14 的做法）。mod 信封诊断把 zod 的 issue 包一层中文（「第 N 项：…」+ 原字段路径），或给 wire schema 配中文 error map。数量：门禁口径 157 条 + 门禁看不见的 wire 文字 16 条 + 理由与拒绝原因 17 条 + `DOMException` 中止文字 5 条。这是模型可见文字变化，第 5 步单独提交并记进流水账。

## 5. 实现层缺陷

按严重度排。「探针」指附录 B 的脚本，都只 import 源码、落盘在草稿区；标了探针的 13 条都实测复现过。

**D1 严重｜安全：sidecar 适配器对未知操作放行，权限闸被绕过。**
- 位置：`runtime/host/sidecar-bridge.ts:430-470`，`createBridgeProxyService.getOperationMetadata` 对不在探测表里的操作返回 `{ permissions: [] }`（`:449`），`invoke` 照样转发给桥。
- 现象：ABI 约定「返回 undefined 就在求权限之前拒绝未知操作」（`contracts/abi/callable.ts:34`），这里反过来，任何操作名都当成零权限操作放行。
- 复现：`probe-e.ts`：宿主 broker 一律拒绝；桥声明过权限的 `execute` 被拒，没声明的 `delete_everything` 直接执行，broker 一次都没被问到。
- 处理：随 HostBridge 整条链删除（1.5）；验收加 INV-2。

**D2 严重：`velaros-kernel-daemon` 的默认装配起不来。**
- 位置：`serve/main.ts:39` 无条件 `registerBundledPacks` → `serve/daemon/bundled-packs.ts:101-122` 三个 `isolation: 'sidecar'` 桩 → `serve/daemon/boot.ts:99-108` 只有设了 `VELAROS_HOST_BRIDGE_ENDPOINT` 才挂 sidecar 适配器。
- 现象：不设那个环境变量（没有任何产品会设）时，`KernelStartupError: Kernel module "velaros.agent.sidecar" failed during activate`，cause `MISSING_ISOLATION_ADAPTER`，守护进程退出。
- 复现：`probe-b.ts` 照 `main.ts` 的顺序装配。
- 另：可执行文件没有权限策略注入口，缺省全拒，就算起来了带权限的能力也一律拒绝（第 7 节 13）。

**D3 中｜安全：模块经自己的权限视图能冒充调用方。**
- 位置：`runtime/host/permission-broker.ts:29-41`，`{ ...request, moduleId, generation }` 把模块给的请求原样展开。
- 现象：`contracts/abi/permissions.ts:16` 写明「模块永远不能指名自己以外的调用方」，宿主路径 `KernelModuleHost.ts:519` 也显式清空了，但模块视图没清：模块在 JS 里给 `request()` 多塞一个 `callerModuleId`，就原样到了宿主的 broker，授权账本按它记。
- 复现：`probe-a.ts` ①：broker 收到 `callerModuleId: "someone.else"`。
- 修：显式列字段（`permission`、`reason`、`scope`、`resource`、`details`），`callerModuleId` 不透传；INV-5。

**D4 中：替换模块时旧代释放失败，旧代服务仍然可见、仍然授权。**
- 位置：`runtime/host/KernelModuleHost.ts:352-372`：失败分支（`:357-366`）没有 `cleanupModule(previous)`；而且顺序是「先释放旧代、再切可见性」（`:372` 才 `activateOwner`），和方法注释「新代就绪后同步切换」相反，释放期间的调用还会打到正在释放的旧代。
- 复现：`probe-a.ts` ②：旧代 `dispose` 抛错后状态 `failed`，但 `getOptionalService` 还拿到旧服务，`requestCapabilityPermission` 仍返回 `granted`。
- 修：先 `activateOwner(新代)`，再释放旧代；释放失败只记旧代失败，新代照常提供；INV-6。

**D5 中：一个事件订阅者抛错，后面的订阅者收不到，发布方跟着失败。**
- 位置：`runtime/host/event-bus.ts:68-71`，顺序 `await` 每个处理器，没有隔离。
- 复现：`probe-a.ts` ③：第一个订阅者抛错，第二个没收到，模块的 `publish` 以别人的错误失败。
- 修：逐个隔离、记日志（行为变化，第 7 节 6）；INV-7。

**D6 中：守护进程崩溃后留下的 descriptor 卡死启动器；`isRunning()` 说谎。**
- 位置：`client/KernelLauncher.ts:204-215`，`tryConnect` 只吞 `DAEMON_NOT_RUNNING` / `DAEMON_DESCRIPTOR_INVALID`，连不上时抛的是 `KernelRpcClientError`（`TRANSPORT_CONNECT_FAILED`）；`:104-111` 的 `isRunning` 只看 descriptor 能不能读。
- 复现：`probe-c.ts`：写一个指向空端口的 descriptor，`ensureRunning()` 直接抛 `TRANSPORT_CONNECT_FAILED`，一次都没 spawn；`isRunning()` 返回 true。
- 修：连接失败按「没有在跑」处理（再核对 descriptor 里的 pid 是否活着），然后照常启动。

**D7 中｜安全（Windows）：私钥凭据的缺省路径在没有 HOME 时落到 `/tmp`。**
- 位置：`remote/client/credential-store.ts:43-48`（`home = process.env.HOME`，空则 `'/tmp'`）；同病 `runtime/host/sidecar-bridge.ts:510`。
- 现象：Windows 通常没有 `HOME`，Ed25519 私钥写到当前盘根的 `\tmp\.velaros\remote-nodes\<slug>.json`；NTFS 上 0600 不生效（文件自己的注释也承认），同机其他用户可读。
- 复现：`env -u HOME bun probe-home.ts` → `/tmp/.velaros/remote-nodes/mac.json`，而 `os.homedir()` 是 `/Users/mac`。
- 修：用 `os.homedir()`。

**D8 中｜安全（Linux 多用户）：守护进程运行目录在共享 `/tmp` 下，不核属主。**
- 位置：`client/contracts/descriptor.ts:33-40`（`<tmpdir>/velaros-kernel-<uid>`）+ `serve/daemon/daemon.ts:76-79`（`mkdir(recursive, 0o700)`，目录已存在时不改权限、不核属主）。
- 现象：另一个用户预先建好这个目录，就能替换 descriptor、把客户端引到自己的 socket，客户端会把认证令牌发过去。
- 修：Linux 用 `XDG_RUNTIME_DIR`；已存在的目录核对属主与 0700，不符就拒绝（第 7 节 10）；INV-15。

**D9 低｜竞态：锁文件刚被别人 `open('wx')`、还没写进 pid 时，会被当成死锁删掉。**
- 位置：`serve/updater/lock.ts:60-76`、`serve/daemon/daemon.ts:151-181`（同一段逻辑两份）。
- 复现：`probe-f.ts`：预建一个空锁文件（模拟对方刚创建），第二个获取者读不出 pid → 删锁 → 拿到锁。真实竞态下两个进程同时持锁。
- 修：读不出属主时按「被占用」处理并短暂重试；两份合一进 `utils/fs.ts`；INV-16。

**D10 低：远程 Client 的凭据存储第一次 `load()` 失败后，之后每次 `connect()` 永远不返回。**
- 位置：`remote/client/RemoteNodeClient.ts:130-144`，`started = true`（`:139`）在 `await load()`（`:140`）之前。
- 复现：`probe-f.ts`：第一次 `connect()` 拒绝，第二次 1 秒后仍挂起，`load` 只被调了一次。
- 修：`load()` 失败时复位 `started` 并拒绝全部等待者。

**D11 低：`mods.*` RPC 的错误码被吞成 `INTERNAL_ERROR`，还标可重试。**
- 位置：`serve/rpc/local-rpc-server.ts:589-601`（`toRpcFailure` 只认三个错误类）+ `runtime/service/KernelService.ts:492-497`（`MODS_UNAVAILABLE` 是 `Object.assign` 挂在普通 `Error` 上的）。
- 复现：`probe-d.ts`：没有 mod 目录时 `mods.list` → `INTERNAL_ERROR`、retryable true、「Kernel RPC request failed」；目录安装失败同样，原因只进守护进程日志。
- 修：错误都带码（3.3），RPC 按码投影；安装失败把原因写进 `details`。

**D12 低：组合快照在降级态直接抛错。**
- 位置：`runtime/host/KernelModuleHost.ts:548-583`，`describeComposition` 先 `resolvePlan()`，依赖图不合法就抛；dispose 之后也抛。
- 现象：Desktop、Workbench 都用 `lifecycleFailureMode: 'degrade'`，启动失败后正是要看快照诊断的时候，快照抛 `MISSING_CAPABILITY`。
- 复现：`probe-g.ts`。
- 修：快照不重新解析依赖图，按登记顺序与当前状态给出，附上解析失败原因；INV-8。

**D13 低：`KernelService` 启动失败后永远报「可重试」，`start()` 永远重放同一个失败。**
- 位置：`runtime/service/KernelService.ts:188-198`（`startPromise` 缓存了失败，状态停在 `idle`）、`:263-271` 与 `:319-328`（`retryable = status === 'idle'`）。
- 复现：`probe-g.ts`：会话打开回 `KERNEL_NOT_STARTED`、retryable true，再 `start()` 仍是同一个 `KernelStartupError`。
- 修：失败进 `failed` 状态，回不可重试。

**D14 低：semver 三份实现口径不一。**
- 位置：`runtime/host/version.ts`（比较时忽略预发布）、`serve/updater/version.ts`（按 SemVer §11 排预发布）、`contracts/protocol/mod-manifest.ts:15-32`（正则，允许 `+build`）。
- 复现：`probe-a.ts` ④：宿主判 `1.0.0-beta.1` 满足 `>=1.0.0`，更新器判不满足；mod 信封接受 `1.0.0+build.1`，宿主的清单校验拒绝（`INVALID_VERSION`）。
- 修：合一进 `utils/semver.ts`（以更新器那份为准，补 `+build`）。宿主的依赖判定会因此变严（预发布不再满足正式范围），计入行为变化。

**D15 低：远程代理模块另抄了一份模块 API 版本。**
- 位置：`remote/module-projection.ts:25`（`RemoteNodeModuleApiVersion = 1`，注释说「与宿主同轴」却另抄一份；写的是常量名不是字面量，`check:kernel-arch` ⑧ 查不到）。
- 现象：模块 API 版本升到 2 时，所有远程代理模块注册即报 `API_VERSION_MISMATCH`。
- 修：引用常量表；INV-22。

**D16 低：serve 路径的权限拒绝丢掉原因。**
- 位置：`runtime/service/KernelService.ts:372-377`。进程内路径的错误消息就是 broker 给的原因；serve 路径统一成一句英文、`details: null`。
- 修：原因进 `details.reason`，两条路径一致。

**D17 设计缺口：进程内调用带不上「调用方归属」，Desktop 因此复刻了一条调用路径。**
- 位置：`runtime/Kernel.ts:174-176` 与 `runtime/capability-invocation.ts:144-160`：`KernelCapabilityCall.permissionContext` 按类型排除了 `callerModuleId`，调用器也不传；Desktop `src/main/kernel/ModCapabilityBroker.ts:184-252` 于是自己 `getOperationMetadata` → 逐条 `requestCapabilityPermission(…, attribution)` → `invoke`，正是宪章 §15.6 与本包 README 禁止的「产品仓重写调用权限门」。
- 修：`KernelCapabilityCall` 加宿主专用的 `attribution`，调用器原样交给宿主的授权判定（第 7 节 5）。

**D18 低：身份注册表的 `runGenerations` 只增不减。** `runtime/service/identity-registry.ts:50、114-122`：长寿守护进程里每个用过的 run id 永久占一格。随身份注册删除而消失（第 7 节 3）。

**D19 低：更新器每次激活写一份指针备份，从不清理。** `serve/updater/KernelUpdater.ts:519-533`；`pruneVersions` 不管 `backups/`。

**D20 低：启动器停机没有期限；`dispose()` 会杀掉别的产品也在用的共享守护进程。** `client/KernelLauncher.ts:177-193`：SIGTERM 之后无限等 `exit`；spawn 了 `detached` 却不 `unref`（`:223`），父进程退不出。修：宽限后 SIGKILL（`KernelTuning.launcher`）；「谁起的谁收」还是「守护进程空闲自退」要定（第 7 节 11）。

**D21 低：本机 RPC 客户端断线后订阅静默失效。** `client/socket-transport.ts:432-446`：`onClose` 清空 `eventHandlers`，下次请求会重连，但订阅不会恢复、也不通知调用方。

**D22 低：注释与代码不符。** `client/discovery.ts:56-72`：注释说「先核对 descriptor 版本再信任 socket」，代码先握手（令牌已经发出去）再核版本。`replaceModule` 的注释见 D4。

**D23 低：已配对时再开配对窗口，任何新 clientId 用配对码都能顶掉旧凭据；落盘等待期间同一个码可被第二条连接复用。** `remote/node/RemoteNodeServer.ts:369-416`：注释说的保护（「已配对的 clientId 不接受再次配对」）只挡同一个 clientId；`pairing.close()`（`:414`）在 `await save()`（`:402`）之后；换人配对也不清终态回放缓存（`unpair()` 会清）。修：`accept` 成功即关窗；换配对对象时清回放缓存；「开窗即允许覆盖」写进卡片。

**D24 低：清单修订号对工具 `inputSchema` 的键序敏感。** `remote/shared/manifest.ts:16-30` 只排了能力、操作、工具，没规范化 schema 对象的键；同样的清单换个键序就换修订号，在途调用被当成过期拒绝。

**另两处设计上的弱点（不算代码缺陷，放第 7 节）**：远程节点 `ws://` 明文、认证后的帧没有完整性保护（第 7 节 9）；更新清单可以走明文 HTTP 且缺省不验签（第 7 节 8）。

## 6. 步骤与风险

### 6.1 总体策略

**先内后外。** 第 0–5 步只动包内：入口名一个不改、`package.json` 的 `exports` 一个不删，只删全仓零消费的导出（sidecar 三件、HostBridge、bundled 桩，另见 7-3、7-4 定下的两块）。八个能力包、三个产品在这五步里零改动，它们的 `workspace:*` 与钉版都不用动。第 6 步一次收口（破坏性，0.2.3 → 0.3.0，按 3.4 节迁移表），下游 65 个 import 文件加 11 个门禁脚本跟改。第 7 步登记治理。

搬家用仓库现成的 `scripts/ownership/debarrel.mjs`、`move-files.mjs`、`move-declarations.mjs`（它们改写 `packages/`、`tests/`、`scripts/` 里的相对 import）。每一步单独提交、不推送；并行实例在场时用临时索引加暂存集硬闸提交，不用 stash。

**kernel 和别的包不一样的两点**（决定了步骤怎么切）：

1. **它是八个能力包的公共底座。** `./contracts/abi` 是全仓被消费最多的入口（40 个文件），八个能力包的 `kernel-module.ts` 全靠它。第 6 步把它并进根入口，等于同一次改动横切八个正在各自改造的包。所以 **kernel 的第 6 步必须排在 model、office、computer 三个包的入口收口之前**（它们还没开始改，正好直接照新入口写），并且和 agent、browser、memory 已收口的部分错开提交。反过来如果拖到最后做，这三个包要为同一件事改两遍。
2. **三个产品钉的是 0.x 版本。** Desktop `^0.2.3`（caret 在 0.x 上等价于 `>=0.2.3 <0.3.0`）、Workbench `0.2.3`、Termel 两个包 `0.2.3`。升 0.3.0 不会被任何一个产品自动吃到——这是好事（不会静默崩），但也意味着第 6 步之后三个产品各要显式升版并改代码，按全链发版手册走。

**每步的「全绿」口径**（下表按编号引用）：
① `bun run --cwd packages/kernel typecheck`；
② `bun run --cwd packages/kernel test`（基线 144 pass / 0 fail、0.45 秒；只许因挪位换位置、不许减，修缺陷的步骤新增用例）；
③ `bun run --cwd packages/kernel build` 再 `bun run check:kernel-schemas`（`build` 里的 `generate:schema-snapshot` 产出 `dist/schema-snapshot.json`，门禁与 `baselines/kernel/kernel-wire-schema-snapshot.json` 逐 schema 比对；**只有第 5、6 步允许 `SCHEMA_BASELINE_UPDATE=1` 重绑**，并在提交信息里写清差异）；
④ `bun run check:kernel-arch`（零违规基线 `baselines/kernel/arch-boundaries-baseline.json`；八道防线里③④⑧按路径与标记串钉着源码，第 3 步要在同一提交改写脚本）；
⑤ 根 `bun run typecheck`、`bun run lint`、`bun run check:code-style`；
⑥ `bun scripts/ownership/check-module-ownership.mjs --only kernel`（第 0 步登记后看燃尽；其余七个已治理包保持 ✓）；
⑦ 根 `bun run test`（工作区全量——八个能力包各自的 `kernel-module.test.ts` 是 kernel 真正的回归网，比包内 144 条更能发现 ABI 破坏）；
⑧ `bun run check:package-pack`、`check:package-catalog`、`check:lockfile-consistency`、`check:host-contract-consumer`（第 3 步起，只要动了 `package.json` 就跑）；
⑨ 第 6 步跑整条 `bun run check`；三个产品按全链发版手册做本地发布覆盖后各跑自己的 typecheck 与测试。

### 6.2 步骤

| 步骤 | 内容 | 全绿口径 | 规模 | 碰到的共享文件 |
| --- | --- | --- | --- | --- |
| **0 登记（迁移中）** 不动一行源码 | 登记表加 kernel 一项，`status: 'migrating'`，`layers` 按 2.3 的三层填目标路径；不填 `toolsFile`、`toolDefiner`、`hostPort`（同 platform，本包没有模型面工具）。顺手处理两个孤儿门禁：`scripts/kernel/check-package-consumers.mjs` 断言 `main === ./dist/index.js`、`files` 含 `docs`，改造后必然不成立，又没有任何 npm 脚本调用它——删掉（`scripts/capabilities/check-packed-consumers.mjs` 归 capabilities，只在它的 `@velaros-ai/kernel/contracts/abi` 那行留注释） | ⑥（燃尽起点：约 900 条）、⑤ | 2 个脚本 | `governed-modules.mjs`、`scripts/kernel/check-package-consumers.mjs` |
| **1 去包名自引用与中间 barrel** 导出面一个名字不变 | `src` 里 30 个文件 53 处 `@velaros-ai/kernel*` 自引用改成相对路径（`test` 里 24 处一并改）；`remote/` 两个文件经根入口绕回 runtime 的那条也改直连——门禁的分层检查看不见包名自引用，`move-files.mjs` 也不改写它们，不先去掉第 3 步会搬出一堆断链。18 个 `index.ts` 里的 6 个中间 barrel（`contracts/service/`、`runtime/host/`、`runtime/service/`、`serve/daemon/`、`serve/internal/`、`serve/rpc/`）用 `debarrel.mjs` 改成逐名转发，12 个入口文件的 `export *` 同样展开成逐名——展开后才看得清哪个名字从哪来，第 6 步删导出时不会误伤 | ①②③（schema 不变）④⑤ | 约 54 个文件，净增约 200 行转发 | 无 |
| **2 删死代码、逐条修缺陷、补远程测试** 入口不变 | **删**（需 7-2）：`runtime/host/sidecar-bridge.ts`（514 行）、`host-bridge.ts`（73 行）、`bundled-packs.ts` 的三个 sidecar 桩、`boot.ts` 的 `hostBridges`/`hostBridgeEndpoint` 两个选项与自动挂载、`main.ts` 的 `registerBundledPacks`、两个环境变量、6 个测试——**D1（未知操作绕过权限闸）与 D2（`velaros-kernel-daemon` 默认装配起不来）随这一刀同时消失**；若 7-3 通过再删身份注册整块（`identity-registry.ts` 152 行 + `contracts/service/identity-inputs.ts` + `contracts/protocol/identity.ts` + RPC 8 个方法 + `KernelService` 的身份面，D18 随之消失）。**修**：D3（模块冒充调用方，显式列字段）、D4（替换模块先切可见性再释放旧代）、D5（事件订阅者隔离，需 7-6）、D6（连不上按「没在跑」处理）、D7（`os.homedir()`）、D8（`XDG_RUNTIME_DIR` + 属主与 0700 核对，需 7-10）、D9（锁文件读不出属主按占用处理）、D10（`started` 复位）、D11（错误带码、RPC 按码投影）、D12（快照不重解析依赖图）、D13（失败进 `failed`）、D16（拒绝原因进 `details.reason`）、D19（备份指针纳入 `pruneVersions`）、D20（停机宽限后 SIGKILL + `unref`）、D21（重连后订阅失效要通知调用方）、D22（注释改对）、D23（`accept` 成功即关窗、换配对清回放缓存）、D24（修订号规范化 schema 键序）。D14（semver 三份合一）、D15（模块 API 版本引常量）留到第 4 步和 utils 合并一起做。**补**：`test/remote/` 新建——远程节点 17 个文件 2,478 行现在本仓零测试，只靠 Termel 的 e2e 跨仓兜底；按 INV-17…INV-20 补握手拒付、回放幂等、epoch 判死、配对锁定四组，另加并发闸一组（2.7 里还没编号，第 7 步补进 `spec/invariants.md` 时给 INV-24） | ①②（新增约 45 条用例）③④⑤⑦ | 删约 700 行（7-3 通过再删约 350 行）；修改约 20 个文件、约 400 行；新增测试约 700 行 | 无（`package.json` 不动） |
| **3 整文件搬家** 只搬不改，入口名与 `exports` 指向的名字不变 | 按附录 A 的去处整文件 `git mv`：含类的进 `impl/<域>/`，纯函数进 `utils/<域>/`，纯类型进 `types/`，混合文件先整个落到 `impl/` 暂放（第 4 步再拆）。12 个入口文件搬进 `src/exports/`，文件名先用临时名（`index.ts`、`contracts.ts`、`contracts-abi.ts`、`contracts-protocol.ts`、`runtime.ts`、`client.ts`、`client-contracts.ts`、`serve.ts`、`serve-updater.ts`、`remote.ts`、`remote-client.ts`、`remote-node.ts`），`package.json` 的子路径名一个不变、只改指向（`./contracts/abi` → `dist/exports/contracts-abi.js`）。可执行入口 `serve/main.ts` 搬到 `bin/velaros-kernel-daemon.mjs`（顶层 await 脚本在五目录里没有位置），`package.json` 的 `bin`、`files` 与 `bun.lock:210` 同一提交改。**同一提交改所有按路径钉住内核源码的地方**（1.3 节末表） | ①②③④（同提交改脚本里钉的路径）⑤⑦⑧ | 106 次 `git mv`；相对 import 改写数百处（脚本自动）；`package.json` 与 `bun.lock` 各一处 | `scripts/kernel/check-arch-boundaries.mjs`（③④⑧三道防线钉的 5 条路径与 3 个标记串）；`eslint/kernel.config.mjs:311-347`；`scripts/mod/velaros-mod.mjs:9-12`；`packages/kernel/scripts/generate-schema-snapshot.mjs:12-13`；根 `tsconfig.json:75-80`；`bun.lock:210`；`docs/generated/package-catalog.json` |
| **4 拆混合文件、闭包改类、错误类合并、常量四处** 入口不变 | 拆 12 个一文件多类的文件（`call-runner.ts` 拆三个类、`service-registry.ts` 拆两个、`client-access.ts` 拆两个……）；8 处闭包工厂与对象字面量改成类（`createScopedPermissionBroker`、`createNamespacedStateStore`、`KernelEventHub.forModule`、`createKernelCallableCapability`、`createRemoteNodeFileAuditLog`、`createRemoteNodeFileCredentialStore`、`createRemoteNodeProjection`、`nodeKernelFetch`，见 2.2 的 ★）；20 个错误类合并成 4 个带码的（`utils/errors.ts`，2.2 末表），原子类的专属字段收进 `details`；26 个类逐个配上方接口（公开成员逐个写中文说明）、`KernelUpdateLock.acquire` 静态改同文件工厂；205 个函数里不用实例状态的私有方法与模块级私有函数进 `utils/`（按 2.4 的表分 37 个文件）；实现文件里的类型全部搬进 `types/`（2.5 的七个文件，`types/kernel.ts` 是唯一可移植文件，`CapabilityToken` 的 `unique symbol` 品牌改可选幽灵字段）；散落的 30 处数字进 `utils/tuning.ts` 与常量表；**D14（semver 三份合一进 `utils/semver.ts`，以更新器那份为准补 `+build`）与 D15（远程代理模块的 API 版本引常量表）在这一步落地** | ①②③④⑤⑥（燃尽到只剩合同、入口、卡片三类）⑦ | 约 110 个文件；照 project 的做法按目录拆 4 路并行：runtime / serve+client / updater / remote 两侧，各改各的目录，用临时索引提交 | 无 |
| **5 合同三文件与中文化** 入口不变，但**模型与用户可见文字全变** | 写 `contract/provides.ts`（3.1 的 22 个接口登记）、`requires.ts`（3.2）、`constants.ts`（3.3 的常量表）；按 3.5 的 11 条处理与标准冲突的地方（wire 类型手写 + `satisfies z.ZodType<…>`、`KernelModuleImporter` 注入面取代动态 import……）。第 4 节的约 190 条英文改中文：门禁口径 157 条 + 走 `failure()`/`sessionFailure()`/`rpcFailure()` 函数参数、门禁看不见却正是 wire 上 `error.message` 的 16 条 + 权限理由与拒绝原因 17 条 + `DOMException` 中止文字 5 条；mod 信封诊断给 zod 配中文 error map。「kernel protocol v2」7 处写死改引 `KernelVersionAxes.protocol`。若 7-7 通过，`CAPABILITY_NOT_AVAILABLE`/`CAPABILITY_NOT_FOUND` 二选一也在这一步做 | ①②③（文字不进 schema，快照应当不变；7-7 通过才用 `SCHEMA_BASELINE_UPDATE=1` 重绑）④⑤⑥⑦ | 约 60 个文件；合同三文件约 900 行 | 无。**这是模型可见文字变化，单独提交并记进 `docs/engineering/foundation-refactor-log.md`** |
| **6 入口收口 0.3.0** 破坏性；排在 model / office / computer 入口收口之前 | `src/exports/` 收成 5 个文件：`index.ts`、`contracts.ts`、`client.ts`、`serve.ts`、`remote.ts`（2.6 的理由）；`package.json` 的 `exports` 删掉 7 个子路径；provides 登记，工厂与实例按公开接口标注类型；删 3.4 节列出的约 290 个声明（67 个 zod schema、37 个类、20 个错误类、宿主与 serve 的零件函数、两个命名空间……）；0.2.3 → 0.3.0。**下游按 3.4 的迁移表跟改**：`@velaros-ai/kernel/contracts/abi` → `@velaros-ai/kernel` 是纯 codemod（40 个文件），真要动代码的是四类——SDK 三个顶层函数改 `kernelModules.*`（Platform 约 16 个文件、Desktop 1）、`new Kernel()` → `createKernel()`（Desktop 2、Workbench 4）、4 处 `instanceof` 改按码判断（Workbench 3 个错误类、agent 1 个）、memory 的 `new KernelModuleHost` 改 `createKernel()` 并把 `getOptionalService` 适配到 `kernel.getCapability`（2 个文件，唯一有真实逻辑改动的）。Termel 8 个文件几乎每个都改（`booted.createClient()`、`kernelDaemons.connect`、`modsRoot`、三个远程存储工厂改名、`RemoteNodeCredentialStore` 两侧分名、`createManifest` 删，需 7-12） | ⑨ | Platform 36 个 import 文件 + 11 个门禁脚本；Desktop 16；Workbench 5；Termel 8 | 根 `tsconfig.json`；`scripts/kernel/check-arch-boundaries.mjs`（入口名变了，③的 subpath 判定跟着变）；`scripts/model/check-arch-boundaries.mjs:107`（钉死 model 只许 import `@velaros-ai/kernel/contracts/abi`，同一提交改）；`scripts/capabilities/check-lockfile-consistency.mjs`、`scripts/memory/checks/*`、`scripts/model/checks/*` 三处锁文件一致性；`package-catalog.json`；`bun.lock`（工作区版本按发版手册手改）；README 与 `docs/client.md`、`docs/serve.md` 合成一份中文 README |
| **7 登记治理** | 登记表去掉 `migrating`，填 `portable: 'kernel.ts'`、`tuning: 'tuning.ts'`、`browserSafeEntries: ['index.ts', 'contracts.ts']`、`environmentTable: 'KernelEnvironmentVariables'`、`layers`、`card`、`invariants`、`acceptance`；不填 `toolsFile`、`toolDefiner`、`hostPort`、`hostPortField`。写 `MODULE.md` 十节（吸收 README、`docs/client.md`、`docs/serve.md`；「骨干链路」写每件能力怎么回答，不是工具链路）、`spec/invariants.md`（2.7 的 23 条：测试档 17、门禁档 5、类型档 1）、`spec/acceptance.test.ts`（每条测试档不变量一条以编号开头的用例）、`spec/support.ts` | `bun run check:module-ownership` 零条、`bun run check:gates`、⑨ | 卡片约 300 行；验收约 17 条 | `governed-modules.mjs` |

### 6.3 风险

- **和八个能力包的改造交叉（最大的一条）。** `./contracts/abi` 是全仓被消费最多的入口，第 6 步把它并进根入口会横切八个包。改造队列现在是 agent → browser → memory → kernel → model → office → …，agent 第 3 步在做、browser 与 memory 的方案刚出。**建议把 kernel 的第 6 步钉在 model 开工之前**：这样 model、office、computer、agent-lab 等后面的包一上来就照新入口写，只改一次；agent、browser、memory 三个先走的包在它们自己的第 6 步里顺手换掉 kernel 的 import（它们本来就要改自己的入口）。若这个顺序排不下来，退而求其次是把第 6 步拆成 6a（只做 import specifier 的 codemod，值名不变——但这要求根入口先把 abi 那 18 个名字原样转发一遍，等于多一个中间态）和 6b（值名收口），代价是多升一次版本、多一轮公开 API 基线重算。
- **并行实例把工作区弄红。** 现在 agent（第 3 步进行中）、project、system、memory、browser、office、computer、model 八路都有未提交改动。kernel 的第 0–5 步只碰 `packages/kernel/` 与三个脚本，冲突面很小；第 6 步要改 36 个 Platform 文件，正好和它们撞。按已有做法：第 6 步在隔离 worktree 里做，门禁在 worktree 里跑，回主仓用临时索引加暂存集硬闸提交；第 4 步的 4 路并行同样各用临时索引。
- **VelarScript-Libraries 跨仓按 dist 路径读 wire schema。** `packages/contract-codegen/tests/support/platform.mjs:20` 读本地 Platform 的 `packages/kernel/dist/contracts/protocol/index.js`，把 56 个 schema 当「真实目标」，并且 `kernel.manifest.json`、`kernel.report.json` 两份产物已经提交进那个仓。第 3 步 dist 结构一变、第 6 步 `./contracts/protocol` 入口一删，那个测试就红，而它不在本仓的 `check` 链上、不会提前暴露。处理：第 3 步就去那个仓把路径改成新的 `dist/exports/contracts.js`（或让它改从包入口解析），第 6 步重生成两份产物；这条要在第 3 步的提交信息里点名，否则会在别人手里炸。
- **`browserSafeEntries` 依赖 7-2 的裁决。** 根入口做得到「整条值引用链不碰 Node 内置模块」的前提有三个：删掉 sidecar（`node:net`）、能力会话账本随 `KernelService` 去 serve（`node:crypto`，顺手改 `globalThis.crypto.randomUUID()`）、其余运行时只依赖 core 根与 zod。**如果 7-2 决定保留 sidecar，根入口就带着 `node:net`，`browserSafeEntries` 只能剩 `contracts.ts`**，Desktop、Workbench 渲染进程那侧想直接拿内核类型就只能走 `./contracts`，2.6 的入口划分要跟着重排。这一条得在第 0 步之前定。
- **协议没有兼容窗口。** 握手要求版本完全相同（`KernelProtocolVersion = 2`），客户端与守护进程永远同版本发布，所以 7-7 的错误码合并、7-12 的清单来源改形状都不需要过渡期——但也意味着**产品侧必须和 kernel 同一次升级**，不能出现 Termel 还钉 0.2.3、守护进程已经是 0.3.0 的中间态。发版顺序按全链手册：Platform → 产品 → Cloud。
- **`bin` 路径变化容易漏。** `velaros-kernel-daemon` 从 `./dist/serve/main.js` 变成 `./bin/velaros-kernel-daemon.mjs`，`package.json` 的 `bin`、`files` 与 `bun.lock:210` 三处要一起改；`files` 现在含 `docs`（孤儿门禁 `check-package-consumers.mjs` 就是断言这个），卡片吸收 `docs/` 之后 `files` 要改成 `dist`、`bin`、`MODULE.md`、`README.md`、`LICENSE`、`NOTICE`。
- **行为变化清单**（第 2、4、5 步各自的提交要点名，并记进流水账）：D4 替换模块的可见性切换顺序反过来（释放期间的调用不再打到旧代）；D5 一个订阅者抛错不再连累别人（发布方从此不会因别人的错误失败，需 7-6）；D6 启动器把「连不上」当「没在跑」，会真的去 spawn（以前是直接抛）；D12 降级态拿得到快照（以前抛 `MISSING_CAPABILITY`）；D13 启动失败后回不可重试（以前永远标可重试）；D14 semver 口径统一后**宿主的依赖判定变严**，`1.0.0-beta.1` 不再满足 `>=1.0.0`——现有 mod 若用预发布版本号会从能装变成装不上，这条要单独在流水账里写清；D16 serve 路径的拒绝开始带上宿主给的原因；D23 配对窗口开着时换人配对会清掉终态回放缓存；第 5 步所有报错文字变中文，**宿主若按英文文本判断失败会失效**（同 system 在 09-15 20:14 的改口，外面一律改按码）。
- **远程节点补测试可能反挖出新缺陷。** 2,478 行零测试的代码，D10、D23、D24 都是读出来的、没有用例钉过。第 2 步补测试时很可能再冒出几条；预留余量，别把第 2 步的工期算死。
- **`check:kernel-arch` 的八道防线按路径与标记串钉源码。** 防线③钉 `src/contracts`、`src/runtime`、`src/client`、`src/serve/updater` 四条 subpath，防线④钉「wire schema 只能定义在 `src/contracts/protocol`」，防线⑧钉 `runtime/Kernel.ts`、`serve/daemon/boot.ts`、`runtime/service/KernelService.ts` 三个文件里的标记串。第 3 步搬家后这四条全部失效；必须**在同一个提交里**把脚本改成按新目录判定（2.3 节列了改写后的六条规则），否则门禁要么全绿（实际没在查）要么全红。这是最容易做成「假绿」的地方。
- **`bun test` 只能在包目录跑。** 仓库根 `bun test` 会把别的包的用例一起吃进来；kernel 的口径是 `bun run --cwd packages/kernel test`（脚本是 `bun test test`）。

## 7. 需要你拍板的项

| # | 事项 | 选项 | 我的建议 | 影响谁 |
| --- | --- | --- | --- | --- |
| 7-1 | **入口收口与类不出包**：12 个入口收成 5 个（`.`、`./contracts`、`./client`、`./serve`、`./remote`）；`new Kernel()` → `createKernel()`；三个 SDK 顶层函数改 `kernelModules.token/define/callable`；20 个错误类不出包、外面按码判断；0.2.3 → 0.3.0 | 照做 / 保留 `./contracts/abi` 不并（它一个人占 40 个消费文件） | 照做。入口名不能带 `/` 是门禁硬约束，`./contracts/abi` 没办法原样保住；`new Kernel()` 写在宪章 §15.2/§15.6 与本包 README 里，改法同 ADR 0005 把 `new SystemPlatformCompatibility()` 改 `createPlatform()` 的先例，文档跟改 | 对外契约；Platform 36 个文件、Desktop 16、Workbench 5、Termel 8；Desktop 仓 `docs/kernel-contract.md` 三节要改口 |
| 7-2 | **删 HostBridge / sidecar 整条链**（`sidecar-bridge.ts` 514 行 + `host-bridge.ts` 73 行 + bundled 桩 + boot 的两个选项 + 两个环境变量 + 6 个测试）；连带 **ABI 的 `KernelModuleIsolationValues` 里 `'sidecar'` 这个值留不留** | 全删含枚举值 / 删实现保留枚举值 | 全删。两边文档都已判退役（Desktop `docs/kernel-contract.md` §15.2「HostBridge 自进程退役」、本仓 `docs/mod-dev/capabilities.md:81`「新 Mod 不得使用」），没有任何产品起 HostBridge 服务端；留着的代价是 D1（未知操作绕过权限闸，探针实测：宿主 broker 一次都没被问到就执行了 `delete_everything`）和 D2（`velaros-kernel-daemon` 默认装配根本起不来）。枚举值留着会让 mod 清单继续能声明一个没有适配器的隔离形态 | ABI 常量表；wire 的 `CapabilityIsolationSchema`（schema 基线重绑）；mod 信封校验；**这条定了才能定 `browserSafeEntries`（见 6.3）** |
| 7-3 | **身份注册 RPC 整块去留**：`KernelIdentityRegistry`（152 行）、`contracts/service/identity-inputs.ts`、`contracts/protocol/identity.ts`、`KernelRpcMethods` 里 8 个方法、`KernelService` 的身份面。全仓与三个产品零调用 | 删 / 留 | 删（git 里可找回）。它是会话与运行身份的登记面，设计上属于产品的会话层而不是内核；留着还带 D18（`runGenerations` 只增不减，长寿守护进程里每个用过的 run id 永久占一格）。`KernelRpcMethods` 从 19 个降到 11 个 | 协议面（RPC 方法表缩小，schema 基线重绑）；无现有消费方 |
| 7-4 | **`mods.*` RPC 三个方法（list / setEnabled / installFromDirectory）留不留**：`KernelClient` 上零调用，但 `docs/agent/agent-mod-trunk.md` 的设计依赖 `mods/list` | 留 / 删 | 留。mod 主干重建那条线明确要用它，删了过几周还要加回来；但 D11 要修（现在错误码被吞成 `INTERNAL_ERROR` 还标可重试，安装失败的原因只进守护进程日志） | 产品面 `KernelClientApi` 的 8 个成员里占 3 个 |
| 7-5 | **进程内调用补「调用方归属」**：`KernelCapabilityCall` 加宿主专用的 `attribution`，调用器原样交给宿主的授权判定 | 加 / 维持现状 | 加。现在 `permissionContext` 按类型排除了 `callerModuleId`、调用器也不传，Desktop 的 `ModCapabilityBroker.ts:184-252` 于是自己 `getOperationMetadata` → 逐条 `requestCapabilityPermission(…, attribution)` → `invoke` 复刻了一条调用路径——**这正是宪章 §15.6 与本包 README 明令禁止的「产品仓重写调用权限门」**，而且它和内核那条路径以后会各修各的 | 产品面 `KernelApi.invokeCapability` 的签名；Desktop 可以删掉约 70 行自建调用路径 |
| 7-6 | **事件订阅者失败隔离**（D5）：一个订阅者抛错，现在后面的订阅者收不到、发布方跟着失败 | 隔离 + 记日志 / 维持「一个失败全失败」 | 隔离。现在的语义等于任何一个模块的订阅回调都能让别的模块的 `publish` 失败，是跨模块的故障传染 | 行为变化；INV-7 |
| 7-7 | **wire 错误码二选一**：同一件事现在三个码五种说法——进程内抛无码错误 `has no active provider`，会话打开回 `CAPABILITY_NOT_AVAILABLE`「is not loaded」，调用回 `CAPABILITY_NOT_FOUND`「is not available」，绑定策略说「is not provided by any loaded module」 | 合并成一个码 / 保留两个码但把文字统一 | 合并成 `CAPABILITY_NOT_AVAILABLE` 一个。协议没有兼容窗口（握手要求版本完全相同），合并不需要过渡期；两个码在语义上区分不出来，现在连内核自己都用混了 | 协议面（schema 基线重绑）；Termel 工具网关把 `error.code` 原样转出去 |
| 7-8 | **更新器 `./serve/updater`（14 个文件 1,839 行）去留**；留的话要不要**强制 HTTPS 并默认验签** | 删 / 留且加固 / 留且维持现状 | 留且加固。它和 `KernelLauncher` 是「共享 Runtime 安装—启动」的两半，`KernelVersionResolver` 没人实现、全仓没有一处把两者接起来，所以现在零消费——但这是还没接线，不是废弃。加固两条：`isRemoteKernelUrl` 现在放行明文 HTTP，`UnverifiedKernelArtifactSignatureVerifier` 是缺省实现（默认不验签），这两条合起来等于「可以从明文 HTTP 装一个未验签的内核运行时」 | 对外契约（`./serve/updater` 并进 `./serve`）；若加固，宿主必须注入验签实现才能装 |
| 7-9 | **远程节点传输安全**：`ws://` 明文，认证通过后的帧没有完整性保护（Ed25519 只用在 challenge 上） | 现状 + 文档写明「只在可信网络用」 / 强制 `wss://` / 认证后对帧做 MAC | 至少要定一条并写进卡片与 mod 文档。缺省只绑回环（43180–43190）时风险可控；一旦用户按文档把节点开到局域网，配对之后的全部能力调用与结果都是明文、可篡改。我的建议是先做「非回环绑定必须 `wss://`」，MAC 留到协议 v2 | 协议；Termel 的无头节点部署方式；用户文档 |
| 7-10 | **数据根与运行目录归属**：更新器自己按平台算安装根（`LOCALAPPDATA` / `XDG_DATA_HOME` / `~/Library/Application Support`），和 `@velaros-ai/platform` 的 `velarosSharedResources.dataRoot()` 是同一套惯例，而且**Linux 上一个叫 `velaros`、一个叫 `VelarOS`**；守护进程运行目录在共享 `/tmp` 下且不核属主（D8） | 交给 `@velaros-ai/platform` 统一 / kernel 自持一份 | 交给 platform（ADR 0005 的分工就是「跨平台兼容去 platform」），kernel 加一条 `@velaros-ai/platform` 依赖；运行目录 Linux 改用 `XDG_RUNTIME_DIR`，已存在的目录核对属主与 0700，不符就拒绝 | kernel 的依赖表多一个包；Linux 上的数据根大小写要统一（**会改变已安装用户的路径，需要一次迁移或就地兼容**） |
| 7-11 | **启动器归属与守护进程生命周期**：`KernelLauncher` 现在放在 `client/`，但宪章 §15.3 把它划进 serve 部署组合；`dispose()` 会 SIGTERM 掉可能被别的产品共用的守护进程，而且无限等 `exit`、spawn 了 `detached` 却不 `unref`（D20） | 放 `./serve`（我的方案）/ 留 `./client`；生命周期取「谁起的谁收」/「守护进程空闲自退」 | 放 `./serve`；生命周期取「守护进程空闲自退」——共享守护进程本来就是给多个产品附着的，谁先退出谁把它杀掉是错的。停机加宽限后 SIGKILL（`KernelTuning.launcher`） | 入口划分；共享守护进程的多产品场景 |
| 7-12 | **`RemoteNodeManifestSource.current()` 改形状**：只交 `{ capabilities, tools }`，修订号由服务端用唯一算法算（Termel 不再调 `createManifest`，`./remote` 的这个导出删掉） | 改 / 维持现状 | 改。现在修订号由调用方算、服务端也能算，两份算法要一直保持一致；而且 D24 说这个算法对工具 `inputSchema` 的键序敏感——同样的清单换个键序就换修订号，在途调用被当成过期拒绝。收成服务端一处，顺手修 D24 | 注入面；Termel `remote-node.ts` 一处 |
| 7-13 | **`velaros-kernel-daemon` 可执行文件的权限策略注入口**：现在没有，缺省全拒，就算 D2 修好、进程起来了，带权限的能力也一律被拒 | 加环境变量指向策略模块 / 加一个 `--permission-policy <模块路径>` 参数 / 明确「可执行文件只跑零权限能力」 | 加参数（和 `KernelModuleImporter` 同一个口子进来，由 `bin/` 的可执行文件注入），并在卡片里写明不给策略就是全拒。现在这个可执行文件事实上没人能用 | 可执行文件的命令行面；`KernelEnvironmentVariables` |

**先定 1–6**：7-2 决定 `browserSafeEntries` 与第 2 步的删除范围，7-3 决定第 2 步还删不删身份注册，7-1 决定第 6 步的迁移表，7-5、7-6 是第 2 步要落的行为变化。7-7 到 7-13 可以在第 4 步之前定。

## 附录 A：106 个源文件逐个去处

「去处」第一项是第 3 步整文件搬到的位置，其余是第 4、5 步拆出去的部分。方括号里是现在的行数。「删」的都能从 git 找回。★ 表示第 4 步要新建的类（从闭包工厂、对象字面量或脚本改来）。

#### `src/` 根与 `contracts/`（24 个文件）

| 文件（行） | 去处 | 理由 |
| --- | --- | --- |
| `index.ts` [5] | `exports/index.ts` | 根入口，内容按 2.6 重写 |
| `velaros-globals.d.ts` | 留在 `src/` 根 | `.d.ts` 不在门禁「`src` 根不放源文件」的口径里（同 system） |
| `contracts/index.ts` [5] | `exports/contracts.ts` | 两个命名空间删掉，改成转发常量表与可移植类型 |
| `contracts/abi/index.ts` [9] | 删（第 1 步展开、第 6 步随入口合并） | 中间 barrel |
| `contracts/abi/callable.ts` [147] | `impl/runtime/KernelCallableCapability.ts` ★（闭包→类）；4 个接口 → `types/kernel.ts`；`normalizeMetadata`、`isKernelCallableCapabilityService`、`resolveKernelCapabilityOperationReason` → `utils/runtime/callable.ts`；`UnknownKernelCapabilityOperationError` → 并进 `utils/errors.ts` 的 `KernelError`（码 `OPERATION_NOT_FOUND`） | 一个文件里混了 SDK 函数、接口、错误类 |
| `contracts/abi/capability.ts` [46] | 两个接口 → `types/kernel.ts`；`createCapabilityToken`、`requireCapability` → `impl/runtime/KernelModuleKit.ts` ★ 的方法 | `unique symbol` 品牌改可选幽灵字段（2.5） |
| `contracts/abi/events.ts` [26] | `types/kernel.ts`（`KernelEvent`、`KernelEventHandler`）；`KernelModuleEventBus` 接口 → `impl/runtime/ScopedKernelEventBus.ts` ★ 的类上方 | 接口跟着实现走 |
| `contracts/abi/module.ts` [164] | 8 个接口与 4 个类型 → `types/kernel.ts`；`defineKernelModule` → `KernelModuleKit.define`；`KernelModuleIsolationValues` → `contract/constants.ts` 的 `KernelModuleIsolations`（与 wire、mod 信封三份合一） | 常量分四处 |
| `contracts/abi/permissions.ts` [57] | 4 个类型 → `types/kernel.ts`；`KernelPermissionBroker` → `contract/requires.ts`；`KernelModulePermissionBroker` → `impl/runtime/ScopedKernelPermissionBroker.ts` ★ 类上方 | 注入面与产品面分开；**D3 在这里修**（`KernelModulePermissionRequest` 明确不含 `callerModuleId`，INV-23） |
| `contracts/abi/references.ts` [20] | `types/kernel.ts`（ABI 形态保留 `ScopeRef`、`ResourceRef` 原名） | wire 形态改名 `KernelWire*`（2.5） |
| `contracts/abi/state.ts` [13] | `types/kernel.ts` | |
| `contracts/abi/version-axis.ts` [11] | `contract/constants.ts` 的 `KernelVersionAxes` | 四根版本轴合一 |
| `contracts/protocol/index.ts` [13] | 删 | 中间 barrel |
| `contracts/protocol/capability.ts` [181] | 18 个类型 → `types/kernel.ts`（同名异义的四组改 `KernelWire*`）；18 个 schema → `utils/wire/capability.ts`，逐个 `satisfies z.ZodType<…>` | 3.5-1 已定的做法 |
| `contracts/protocol/handshake.ts` [27] | 类型 → `types/kernel.ts`；schema → `utils/wire/handshake.ts` | |
| `contracts/protocol/identity.ts` [24] | **删**（需 7-3）；留则同上 | 身份注册整块 |
| `contracts/protocol/mod-manifest.ts` [152] | `impl/runtime/VelarosModEnvelopeParser.ts` ★；schema 与解析辅助 → `utils/wire/mod-envelope.ts`；诊断与信封类型 → `types/kernel.ts`；`VelarosModManifestFileName` → 常量表；**三份 semver 里的正则那份并进 `utils/semver.ts`（D14）** | `parseVelarosModEnvelope` 是 agent 浏览器面唯一要的值，做成实例方法 |
| `contracts/protocol/mods.ts` [59] | 8 个类型 → `types/kernel.ts`；8 个 schema → `utils/wire/mods.ts` | 需 7-4 |
| `contracts/protocol/negotiation.ts` [60] | `utils/wire/negotiation.ts`；`KernelProtocolNegotiation` → `types/wire.ts` | 两个函数零消费，不再出包 |
| `contracts/protocol/remote-node.ts` [311] | 公开数据（身份、清单、能力/操作/工具描述、错误）→ `types/kernel.ts`；14 种帧 → `types/wire.ts`；31 个 schema → `utils/wire/remote-node.ts`；`RemoteNodeProtocolVersion` → `KernelVersionAxes`，5 个数字上限 → `RemoteNodeLimits`，关闭码 → `RemoteNodeCloseCodes` | 数字上限是两端共同遵守的协议承诺，进常量表不进 tuning |
| `contracts/protocol/schema-snapshot.ts` [153] | `utils/wire/snapshot.ts` | `generate-schema-snapshot.mjs` 按路径读它，第 3 步同提交改 |
| `contracts/protocol/version.ts` [8] | `contract/constants.ts` 的 `KernelVersionAxes.protocol` | 「kernel protocol v2」7 处写死改引它 |
| `contracts/service/health.ts` [19] | `types/kernel.ts` | |
| `contracts/service/identity-inputs.ts` [14] | **删**（需 7-3） | |
| `contracts/service/index.ts` [6] | 删 | 中间 barrel |

#### `runtime/`（21 个文件）

| 文件（行） | 去处 | 理由 |
| --- | --- | --- |
| `runtime/index.ts` [5] | 删（并进 `exports/index.ts`） | |
| `runtime/Kernel.ts` [212] | `impl/runtime/Kernel.ts`（接口 `KernelApi` 写在类上方，工厂 `createKernel`）；`KernelOptions`、`KernelLifecycleFailure` → `contract/requires.ts` 与 `types/runtime.ts`；`KernelStatus` → `types/kernel.ts` | 防线⑧的标记串在这个文件里，第 3 步同提交改脚本 |
| `runtime/capability-invocation.ts` [180] | `impl/runtime/KernelCapabilityInvoker.ts`；5 个错误类 → `utils/errors.ts` 的 `KernelError`（按 `KernelCallErrorCodes` 给码）；`KernelCapabilityCall` → `types/runtime.ts`（带 `AbortSignal`，不可移植）；缺省权限理由文字改中文 | **D17 在这里加 `attribution`（需 7-5）**；`KernelCapabilityPermissionDeniedError`、`KernelCapabilityUnavailableError` 是 Workbench `instanceof` 的两个，第 6 步改按码 |
| `runtime/host/index.ts` [12] | 删 | 中间 barrel |
| `runtime/host/KernelModuleHost.ts` [798] | `impl/runtime/KernelModuleHost.ts`（接口 `KernelModuleHostApi`）；4 个快照接口 → `types/kernel.ts`，`ModuleRecord` → `types/runtime.ts`；`cloneManifest` → `utils/runtime/manifest.ts` | 全包最大的文件；**D4（替换顺序）、D12（快照降级）在这里修** |
| `runtime/host/dependency-resolver.ts` [295] | `utils/runtime/module-plan.ts`（9 个函数全是纯的）；`KernelModulePlan`、`KernelCapabilityProvider` → `types/runtime.ts` | 一个类都没有，整个进 utils |
| `runtime/host/errors.ts` [93] | `utils/errors.ts`（三个错误类并进 `KernelError`）；`KernelHostErrorCode` → `contract/constants.ts` 的 `KernelErrorCodes`；`toError` → `utils/errors.ts` | 门禁允许 utils 放只有字段、写了中文说明的错误类（`ProjectError` 先例） |
| `runtime/host/event-bus.ts` [119] | `impl/runtime/KernelEventHub.ts`；`forModule` 返回的对象字面量 → `impl/runtime/ScopedKernelEventBus.ts` ★；`EventSubscription` → `types/runtime.ts` | **D5 在这里修（需 7-6）** |
| `runtime/host/host-bridge.ts` [73] | **删**（需 7-2） | HostBridge 退役 |
| `runtime/host/isolation.ts` [27] | `KernelModuleIsolationAdapter` → `contract/requires.ts`；`ExternalKernelModuleIsolation` → `types/kernel.ts` | 注入面 |
| `runtime/host/permission-broker.ts` [49] | `impl/runtime/DenyAllKernelPermissionBroker.ts`；`createScopedPermissionBroker` → `impl/runtime/ScopedKernelPermissionBroker.ts` ★ | **D3 在这里修** |
| `runtime/host/service-registry.ts` [301] | 拆两个类：`impl/runtime/KernelServiceStore.ts`、`impl/runtime/ScopedKernelServiceResolver.ts`；`ServiceEntry`、`KernelActiveServiceSnapshot` → `types/runtime.ts` | 一文件多类 |
| `runtime/host/sidecar-bridge.ts` [514] | **删**（需 7-2） | **D1 严重安全缺陷在这里**；写死浏览器 8 个操作名与 `~/.velaros/host-bridge.sock` |
| `runtime/host/state-store.ts` [83] | `impl/runtime/InMemoryKernelStateBackend.ts`；`createNamespacedStateStore` → `impl/runtime/NamespacedKernelStateStore.ts` ★；`KernelStateBackend` → `contract/requires.ts`；`assertStateKey` → `utils/runtime/state.ts` | |
| `runtime/host/version.ts` [124] | `utils/semver.ts`（与另两份合一，以更新器那份为准） | **D14** |
| `runtime/service/index.ts` [6] | 删 | 中间 barrel |
| `runtime/service/KernelService.ts` [530] | `impl/serve/KernelService.ts`（接口 `KernelServiceApi`）；7 个模块级私有函数 → `utils/serve/service.ts`；`KernelServiceLifecycleError` → `utils/errors.ts`；`KernelServiceOptions` → `types/serve.ts` | 搬去 serve 层（根入口才能不碰 `node:crypto`）；**D13、D16 在这里修**；防线⑧标记串在这个文件里 |
| `runtime/service/capability-grants.ts` [95] | `impl/serve/CapabilitySessionLedger.ts`；`operationsCover`、`scopesCover` → `utils/serve/service.ts`；两个接口 → `types/serve.ts` | `node:crypto` 改 `globalThis.crypto.randomUUID()` |
| `runtime/service/client-access.ts` [68] | 拆两个类：`impl/serve/DenyAllKernelClientAccessBroker.ts`、`impl/serve/AllowLoadedKernelClientAccessBroker.ts`；`KernelClientAccessBroker` → `contract/requires.ts`；判定类型 → `types/kernel.ts` | 一文件多类 |
| `runtime/service/identity-registry.ts` [152] | **删**（需 7-3）；留则 `impl/serve/KernelIdentityRegistry.ts` | **D18** |
| `runtime/service/mod-catalog.ts` [22] | `types/serve.ts` | 只有一个接口 |

#### `client/`（12 个文件）

| 文件（行） | 去处 | 理由 |
| --- | --- | --- |
| `client/index.ts` [14] | `exports/client.ts` | |
| `client/contracts/index.ts` [10] | 删 | 中间 barrel |
| `client/KernelClient.ts` [91] | `impl/client/KernelClient.ts`（接口 `KernelClientApi`） | |
| `client/CapabilitySession.ts` [89] | `impl/client/CapabilitySession.ts`（接口 `CapabilitySessionApi`）；`openCapabilitySessionOnTransport` 与 `OpenCapabilitySessionInput` → 类的静态之外的工厂，由 `KernelClient` 调 | |
| `client/KernelLauncher.ts` [245] | `impl/serve/KernelLauncher.ts`（接口 `KernelLauncherApi`，工厂 `createKernelLauncher`；需 7-11）；`KernelVersionResolver`、`KernelLauncherOptions` → `contract/requires.ts`；`KernelLauncherError` → `utils/errors.ts` 的 `KernelClientError`；两个数字 → `KernelTuning.launcher` | 宪章 §15.3 把 launcher 划进 serve 部署组合；**D6、D20 在这里修** |
| `client/socket-transport.ts` [574] | `impl/client/SocketKernelTransport.ts`；10 个模块级私有函数 → `utils/rpc/frames.ts` 与 `utils/rpc/endpoint.ts`；`PendingRequest`、选项 → `types/client.ts` | **D21 在这里修** |
| `client/transport.ts` [84] | `KernelClientTransport` → `contract/requires.ts`；`KernelEventSubscription` → `contract/provides.ts`（直接声明）；`KernelClientEventHandler` → `types/client.ts` | 注入面 |
| `client/discovery.ts` [105] | `impl/client/KernelDaemonDirectory.ts` ★（`discover`、`connect` 两个方法）；`assertProtocolCompatible` → `utils/rpc/descriptor.ts`；`isNodeError` → `utils/fs.ts`（七份合一）；`ConnectedKernelDaemon` → `contract/provides.ts` | **D22（注释与代码不符：先握手后核版本）在这里改对** |
| `client/contracts/descriptor.ts` [120] | `defaultPaths` → `KernelDaemonDirectory` 的方法；`parseKernelDaemonDescriptor`、`parseEndpoint`、`invalidDescriptor` → `utils/rpc/descriptor.ts`；两个接口 → `types/kernel.ts` | **D8（运行目录在共享 `/tmp`）在这里修（需 7-10）** |
| `client/contracts/endpoint.ts` [16] | `types/kernel.ts` | Termel 在用 |
| `client/contracts/rpc-frames.ts` [65] | 5 个接口与 3 个类型 → `types/kernel.ts` 与 `types/wire.ts`；`KernelRpcMethods` → `contract/constants.ts` | 需 7-3 后从 19 个降到 11 个 |
| `client/errors.ts` [47] | `utils/errors.ts` 的 `KernelClientError`（两个类合一，两个 getter 改字段）；`KernelClientErrorCode` → `contract/constants.ts`；`KernelCapabilityGrantErrorCodes` **删**（声明了没人引用，同样的字符串在别处手写） | |

#### `serve/`（13 个文件）

| 文件（行） | 去处 | 理由 |
| --- | --- | --- |
| `serve/index.ts` [11] | `exports/serve.ts` | |
| `serve/main.ts` [81] | `impl/serve/KernelDaemonProcess.ts` ★（`run({ environment, importModule })`）；可执行入口搬到 **`bin/velaros-kernel-daemon.mjs`**（三行，在 `src` 之外） | 顶层 await 脚本在五目录里没有位置（3.5-5）；**D2 的触发点 `registerBundledPacks` 在这里删** |
| `serve/daemon/index.ts` [6] | 删 | 中间 barrel |
| `serve/daemon/boot.ts` [214] | `impl/serve/KernelDaemonAssembly.ts` ★（接口 `BootedKernelDaemonApi`，工厂 `bootKernelDaemon`）；`installKernelShutdownHandlers` → 类的方法；`BootKernelDaemonOptions` → `contract/requires.ts` | 删 `hostBridges`、`hostBridgeEndpoint`、`apiVersion` 三个选项；防线⑧标记串在这个文件里 |
| `serve/daemon/bundled-packs.ts` [163] | `utils/serve/mod-packs.ts`（`bundledModules` 折成 pack 记录、系统 pack JSON 解析）；`sidecarPack` 与 `BundledKernelPacks` 三个桩 **删**（需 7-2） | **写死了 `velaros.agent` 0.3.2 / `velaros.model` 0.3.0 / `velaros.browser` 0.3.0 三个产品能力与版本字面量** |
| `serve/daemon/daemon.ts` [229] | `impl/serve/KernelLocalDaemon.ts`；锁文件四个函数 → `utils/fs.ts`（与更新锁合一）；`writeDescriptor` → `utils/rpc/descriptor.ts`；`KernelDaemonError` → `utils/errors.ts` | **D8、D9 在这里修** |
| `serve/daemon/mod-loader.ts` [260] | `impl/serve/KernelModLoader.ts`；`installModPackFromDirectory`、`loadModIndexIntoStore`、`persistModIndex` 等 → `utils/serve/mod-index.ts`；动态 `import()` 改成注入的 `KernelModuleImporter` | 3.5-4：门禁禁动态 import，导入函数由 `bin/` 交进来 |
| `serve/daemon/mod-store.ts` [186] | `impl/serve/KernelModStore.ts`；`createDefaultKernelModStorePaths`、`registerSystemModPacks` → `utils/serve/mod-index.ts`；三个接口 → `types/serve.ts` | 选项面从 `modStorePaths` 收成 `modsRoot`（Termel 一处跟改）；`~/.velaros/mods` 路径归 7-10 |
| `serve/internal/index.ts` [2] | 删 | 中间 barrel |
| `serve/internal/in-process-transport.ts` [214] | `impl/serve/InProcessKernelTransport.ts`；`InProcessKernelService` → `types/serve.ts` | 不再出包，改由 `booted.createClient()` 给出 |
| `serve/rpc/index.ts` [3] | 删 | 中间 barrel |
| `serve/rpc/local-rpc-server.ts` [725] | `impl/serve/KernelLocalRpcServer.ts`；16 个模块级私有函数里的帧、端点、令牌比较 → `utils/rpc/frames.ts`、`utils/rpc/endpoint.ts`，`isNodeError` → `utils/fs.ts`；`ConnectionContext` → `types/serve.ts`；`defaultMaxFrameBytes` → `KernelRpcLimits`（与客户端那份合一） | **D11 在这里修**；5 处「kernel protocol v2」写死改引常量 |
| `serve/rpc/server-frames.ts` [87] | `utils/rpc/frames.ts`；`KernelRpcProtocolError` → `utils/errors.ts`；模块级 `methodSet`（唯一的模块级状态，是常量 `Set`）→ 跟着方法表进常量表派生 | `rpcFailure` 是门禁看不见的 wire 文字来源之一（第 5 步中文化） |

#### `serve/updater/`（14 个文件）

需 7-8。整块搬进 `impl/updater/` 与 `utils/updater/`，入口并进 `./serve`。

| 文件（行） | 去处 |
| --- | --- |
| `serve/updater/index.ts` [13] | 删（并进 `exports/serve.ts`） |
| `serve/updater/KernelUpdater.ts` [584] | `impl/updater/KernelUpdater.ts`（接口 `KernelUpdaterApi`，工厂 `createKernelUpdater`）；8 个接口与 `KernelHealthCheck` → `contract/requires.ts` 与 `types/kernel.ts`；`DefaultRetainedVersions` → `KernelTuning.updater`；**D19（备份指针从不清理）在这里修** |
| `serve/updater/lock.ts` [128] | `impl/updater/KernelUpdateLock.ts`（静态 `acquire` 改同文件工厂）；锁文件逻辑 → `utils/fs.ts`（与守护进程锁合一）；**D9** |
| `serve/updater/errors.ts` [76] | `utils/errors.ts` 的 `KernelUpdaterError`（三个类合一）；`KernelUpdaterErrorCode` → `contract/constants.ts` 的 17 个码 |
| `serve/updater/extraction.ts` [55] | `impl/updater/PassthroughKernelArtifactExtractor.ts`；`KernelArtifactExtractor` → `contract/requires.ts`；`kernelArtifactFileName` → `utils/updater/extraction.ts` |
| `serve/updater/signature.ts` [49] | `impl/updater/UnverifiedKernelArtifactSignatureVerifier.ts`；`KernelArtifactSignatureVerifier` → `contract/requires.ts`（**7-8 若要默认验签，缺省实现要换**） |
| `serve/updater/transport.ts` [129] | `nodeKernelFetch` → `impl/updater/NodeKernelArtifactFetcher.ts` ★（`KernelFetch` 函数类型改成带 `fetch()` 方法的接口）；`isRemoteKernelUrl`、`fetchKernelText` 等 → `utils/updater/transport.ts`；`MaximumKernelManifestBytes` → `KernelTuning.updater`（**7-8：`isRemoteKernelUrl` 现在放行明文 HTTP**） |
| `serve/updater/manifest.ts` [218] | `utils/updater/manifest.ts`（8 个函数 + 9 个 schema）；7 个类型 → `types/kernel.ts`；`KernelArtifactTargets` → `contract/constants.ts` |
| `serve/updater/layout.ts` [97] | `utils/updater/layout.ts`；`KernelInstallRootVariable` → 常量表的环境变量表（**7-10：平台安装根交给 `@velaros-ai/platform`，Linux 大小写统一**） |
| `serve/updater/installation.ts` [113] | `utils/updater/installation.ts`；`KernelInstalledVersion` → `types/kernel.ts` |
| `serve/updater/pointer.ts` [62] | `utils/updater/pointer.ts`；`KernelActivePointer` → `types/kernel.ts` |
| `serve/updater/download.ts` [112] | `utils/updater/download.ts` |
| `serve/updater/fs-utils.ts` [55] | `utils/fs.ts`（`isNodeError` 七份合一、`ignoreMissing`、`readJsonFile`；`writeJsonFileAtomic` 改用 core 的 `writeJsonFileAtomically`） |
| `serve/updater/version.ts` [162] | `utils/semver.ts`（三份合一的基准，补 `+build`）；**D14** |

#### `remote/`（22 个文件）

| 文件（行） | 去处 | 理由 |
| --- | --- | --- |
| `remote/index.ts` [11] | `exports/remote.ts` | 三个入口并成一个 |
| `remote/client/index.ts` [18] | 删 | 中间 barrel |
| `remote/node/index.ts` [35] | 删 | 中间 barrel |
| `remote/RemoteNodeIsolationAdapter.ts` [205] | `impl/remote-client/RemoteNodeIsolationAdapter.ts`（工厂 `createRemoteNodeIsolationAdapter`）；选项 → `contract/requires.ts`；`RemoteNodeProgressEventType` → 常量表；权限理由文字（含缺省主机名 `the remote host`）改中文 | 装配在 Client 侧，归 `remote-client/` |
| `remote/module-projection.ts` [227] | `impl/remote-client/RemoteNodeProjection.ts` ★（接口 `RemoteNodeProjectionApi`，工厂 `createRemoteNodeProjection`）；`slugifyRemoteHostName`、`namespaceRemoteId`、`namespaceRemoteToolName` → `utils/remote/projection.ts`；`RemoteNodeModuleApiVersion` **删，改引 `KernelVersionAxes.moduleApi`（D15）** | 假定远端 id 都以 `velaros.` 开头，这条写进卡片 |
| `remote/shared/crypto.ts` [100] | `utils/remote/crypto.ts`（含配对码常数时间比较） | 两侧共用 |
| `remote/shared/frames.ts` [84] | `utils/remote/frames.ts` | 两侧共用 |
| `remote/shared/manifest.ts` [43] | `utils/remote/manifest.ts`；`createManifest` **删**（需 7-12）；`computeManifestRevision` **修 D24（规范化 schema 键序）** | |
| `remote/client/RemoteNodeClient.ts` [508] | `impl/remote-client/RemoteNodeClient.ts`（接口 `RemoteNodeClientApi`，工厂 `createRemoteNodeClient`）；`ReadyWaiter` → `types/remote.ts`；`resolveHostPlatform` → `utils/remote/calls.ts` | **D10 在这里修** |
| `remote/client/contracts.ts` [181] | `RemoteNodeClientOptions`、`RemoteNodeSocket`、`RemoteNodeSocketFactory`、`RemoteNodeClientCredentialStore`（改名）→ `contract/requires.ts`；公开数据 → `types/kernel.ts`；工作类型 → `types/remote.ts`；`RemoteNodeClientError` → `utils/errors.ts`（唯一原样保留的错误类）；5 个调优常量 → `KernelTuning.remoteClient`；错误码表 → `contract/constants.ts` | agent 3 处 `instanceof RemoteNodeClientError`，第 6 步改按码 |
| `remote/client/credential-store.ts` [132] | `impl/remote-client/FileRemoteNodeCredentialStore.ts`（工厂 `createRemoteNodeClientCredentialStore({ hostSlug, path? })`）；schema 与缺省路径 → `utils/remote/credentials.ts` | **D7 严重（Windows 无 HOME 时私钥落到 `/tmp`）在这里修** |
| `remote/client/handshake.ts` [97] | `utils/remote/handshake.ts`；`RemoteNodeHandshakeStep` → `types/remote.ts` | 纯函数 |
| `remote/client/close-policy.ts` [85] | `utils/remote/close-policy.ts`；`MaxBackoffExponent` → `KernelTuning.remoteClient` | 纯函数 |
| `remote/client/pending-calls.ts` [264] | `impl/remote-client/RemoteNodePendingCalls.ts`；`describeCall`、`resolveDeadlineMs`、`toWireScope`、`describeNodeError` → `utils/remote/calls.ts`；`PendingCall` → `types/remote.ts` | `node:crypto` 改 `globalThis.crypto` |
| `remote/client/ws-socket.ts` [20] | `utils/remote/ws-socket.ts` | 唯一 import `ws` 的 Client 侧文件 |
| `remote/node/RemoteNodeServer.ts` [526] | `impl/remote-node/RemoteNodeServer.ts`（接口 `RemoteNodeServerApi`，工厂 `createRemoteNodeServer`）；`RemoteNodeConnection` → `types/remote.ts`；端口区间 → `RemoteNodeLimits`，并发与关闭原因长度 → `KernelTuning.remoteNode` 与类的 `private static readonly` | **D23 在这里修** |
| `remote/node/contracts.ts` [180] | 5 个注入接口 → `contract/requires.ts`（`RemoteNodeCredentialStore` 改名 `RemoteNodeServerCredentialStore`）；公开数据 → `types/kernel.ts`；`RemoteNodeSocketPath` → 常量表 | Termel 用了这里 8 个类型 |
| `remote/node/call-runner.ts` [347] | 拆三个类：`impl/remote-node/RemoteNodeCallRunner.ts`、`RemoteNodeInvocationPool.ts`、`RemoteNodeResultCache.ts`；`RemoteNodeInFlightCall` → `types/remote.ts`；`RemoteNodeCompletedCallCapacity` → `KernelTuning.remoteNode` | 一文件三类 |
| `remote/node/pairing.ts` [105] | `impl/remote-node/RemoteNodePairingGate.ts`；`codesEqual` → `utils/remote/crypto.ts` | |
| `remote/node/credential-store.ts` [86] | `impl/remote-node/FileRemoteNodeServerCredentialStore.ts` ★（闭包工厂→类，工厂 `createRemoteNodeServerCredentialStore`）；schema → `utils/remote/credentials.ts`；`isNodeError` → `utils/fs.ts` | |
| `remote/node/audit-log.ts` [59] | `impl/remote-node/FileRemoteNodeAuditLog.ts` ★（闭包里的写队列 `let writing` 改成实例字段，工厂 `createRemoteNodeAuditLog`）；`utcDayStamp` → `utils/remote/calls.ts` | 唯一的闭包可变状态 |
| `remote/node/listener.ts` [107] | `utils/remote/listener.ts`；`isNodeError` → `utils/fs.ts`；两个接口 → `types/remote.ts` | 纯函数 |

**合计**：106 个文件 → `impl/` 47 个类文件（6 个域子目录）、`utils/` 37 个、`types/` 7 个、`contract/` 3 个、`exports/` 5 个，另 `bin/` 1 个；删 4 个（sidecar 两件、7-2/7-3 定下的两块）、18 个 `index.ts` 里的 6 个中间 barrel 删掉、12 个入口收成 5 个。

## 附录 B：脚本与原始数据

全在 `…/scratchpad/plan-kernel/`，只读：脚本只 import 源码或按路径读文件，落盘只在草稿区。

| 文件 | 干什么 | 产出 |
| --- | --- | --- |
| `census.mjs` | 用 TypeScript AST 遍历 `src`、`test`，逐文件数类、错误类、接口、类型别名、函数、常量、模块级状态、Node 内置模块、包名自引用、散落数字、英文文字 | `census.json`（124 KB）、`files.txt`（附录 A 的底稿，每个文件一行：`路径 [行数] node:模块` + `C:`类 `E:`错误类 `I:`接口 `T:`类型 `F:`函数 `K:`常量 `S:`模块级状态，`°` = 未导出） |
| `exports.mjs` | 用类型检查器对 12 个入口文件求 `getExportsOfModule`，按声明去重 | `exports.json`（176 KB）：777 个导出名、去重 500 个声明，1.3 节的入口表 |
| `consumers.mjs` | 扫 Platform 的 `packages`/`tests`/`scripts`/`products`，加 Desktop、Workbench、Termel、Extension、VelarScript-Libraries，按入口汇总被 import 的符号；区分只作类型用（T）与值（V） | `consumers.json`、`consumers-summary.txt`（`134e1d51` 上重跑的），`consumers.v1.json`、`consumers-summary.v1.txt`（首轮 `b9c2746e` 上的，留着对比） |
| `probe-home.ts` | D7：`env -u HOME bun probe-home.ts`，比对 `defaultRemoteNodeCredentialsPath()` 与 `os.homedir()` | 复现：私钥路径落到 `/tmp/.velaros/remote-nodes/mac.json` |
| `probe-a.ts` | D3（模块经权限视图冒充调用方）、D4（替换模块旧代释放失败仍可见仍授权）、D5（一个订阅者抛错连累其余与发布方）、D14（三份 semver 口径不一）四条 | 四条全复现 |
| `probe-b.ts` | D2：照 `serve/main.ts` 的顺序装配 `bundledPacks` + `bootKernelDaemon` | 复现：`KernelStartupError`，cause `MISSING_ISOLATION_ADAPTER` |
| `probe-c.ts` | D6：写一个指向空端口的 descriptor，调 `isRunning()` 与 `ensureRunning()` | 复现：`isRunning()` 返回 true；`ensureRunning()` 抛 `TRANSPORT_CONNECT_FAILED`，一次都没 spawn。`tmp-c/k.endpoint.json` 是它建的假 descriptor |
| `probe-d.ts` | D11：没有 mod 目录时走 `mods.list`，看 RPC 失败帧 | 复现：`INTERNAL_ERROR`、retryable true |
| `probe-e.ts` | D1：宿主 broker 一律拒绝，比对桥声明过权限的操作与没声明的操作 | 复现：`delete_everything` 直接执行，broker 一次都没被问到 |
| `probe-f.ts` | D9（空锁文件被当死锁删掉）、D10（凭据 `load()` 失败后 `connect()` 永不返回）两条 | 两条复现 |
| `probe-g.ts` | D12（降级态 `describeComposition` 抛错）、D13（启动失败后永远标可重试且重放同一个失败）两条 | 两条复现 |
| `tmp-b/`、`tmp-c/`、`tmp-e/`、`tmp-f/` | 探针的临时目录（descriptor、锁文件、凭据文件） | 都在草稿区，跑完可删 |

基线：`bun run --cwd packages/kernel test` → 144 pass / 0 fail，23 个测试文件，0.45 秒，跑完工作区干净。
