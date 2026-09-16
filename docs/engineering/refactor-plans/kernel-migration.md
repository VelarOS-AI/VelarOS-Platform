# `@velaros-ai/kernel` 0.2.3 → 0.4.0 迁移表

两次破坏性发布，一张表。**0.3.0**：12 个入口收成 5 个，288 个导出名从对外面上消失，
23 个名字是新的。**0.4.0**：`./serve` 从 10 个值收到 4 个，ModStore / Loader 的六个装配零件
改成 `KernelModStoreApi` 上的方法（逐条对照在第 6 节）。
本文件按符号逐条给出去向，并标出每一条在 Platform 仓内与三个产品仓（Desktop、Workbench、
Termel）里的消费点数量；表里写的是**落到 0.4.0** 的最终写法，从 0.2.3 直接升的照着改一次就到位。

- 仓内消费点**本轮已全部改完**（提交 `refactor(capabilities): 九个包的 kernel 引用改到收口后的五个入口`）。
- 产品仓的调用点**本轮不改**，只列进第 5 节，由各产品仓自己按这张表改。
- 判断口径：消费点 = 直接 `import … from '@velaros-ai/kernel*'` 的源文件数（注释与文档不计）。

改造方案见 `kernel.md`（§2.6 五个入口、§3.4 要删的导出与替代）；仓库标准见
`docs/architecture/module-ownership.md`。

---

## 1. 入口前后对照

| 旧入口（12） | 新入口（5） | 说明 |
| --- | --- | --- |
| `.` | `.` | 进程内内核 + 模块 SDK + **全部**公开契约类型 |
| `./contracts` | `./contracts` | 内容全换：原先是 `KernelAbi` / `KernelProtocol` 两个命名空间，现在是常量表 + `types/kernel.ts` 的可移植数据 |
| `./contracts/abi` | `.`（值与合同接口）/ `./contracts`（数据） | 入口名不许带 `/`（门禁硬约束） |
| `./contracts/protocol` | `.` | wire 数据类型进根入口；zod schema 不再出包（见 §4.1） |
| `./runtime` | `.` | 与 `.` 本来就大面积重叠 |
| `./client` | `./client` | 只剩一件值 `kernelDaemons`；类型全在 `.` |
| `./client/contracts` | `.` / `./contracts` | descriptor / endpoint / RPC 帧数据 |
| `./serve` | `./serve` | 值收窄；类型全在 `.` |
| `./serve/updater` | `./serve` | 更新器并入同一部署组合 |
| `./remote` | `./remote` | 值收窄成七个工厂；类型全在 `.` |
| `./remote/client` | `./remote`（值）/ `.`（类型） | 两侧依赖闭包相同，合成一个入口 |
| `./remote/node` | `./remote`（值）/ `.`（类型） | 同上 |

新入口的值一共 33 个（0.3.0 时是 39 个，0.4.0 去掉 `./serve` 的六个装配零件）：

| 入口 | 值 |
| --- | --- |
| `.` | `createKernel`、`kernelModules`、`velarosModEnvelopes`，加 `contract/constants.ts` 的 18 张常量表与身份字符串 |
| `./contracts` | 同一批常量表（`.` 的可移植子集），没有别的值 |
| `./client` | `kernelDaemons` |
| `./serve` | `bootKernelDaemon`、`kernelDaemonProcess`、`createKernelLauncher`、`createKernelUpdater`（0.4.0 起只有这四件，见 §6） |
| `./remote` | `createRemoteNodeClient`、`createRemoteNodeServer`、`createRemoteNodeProjection`、`createRemoteNodeIsolationAdapter`、`createRemoteNodeClientCredentialStore`、`createRemoteNodeServerCredentialStore`、`createRemoteNodeAuditLog` |

`browserSafeEntries` 仍是 `index.ts` 与 `contracts.ts`：这两条的引用链不碰 Node 内置模块（INV-11），
渲染进程可以直接加载。

---

## 2. 新增的名字（23）

| 新名 | 它顶替了谁 |
| --- | --- |
| `KernelVersionAxes` | `KernelVersion`（`.kernel`）、`KernelModuleApiVersion`（`.moduleApi`）、`KernelProtocolVersion`（`.protocol`）、`RemoteNodeProtocolVersion` / `RemoteNodeModuleApiVersion`（`.remoteNodeTransport` / `.moduleApi`） |
| `KernelErrorCodes`、`KernelCallErrorCodes`、`KernelUpdaterErrorCodes`、`RemoteNodeErrorCodes`、`RemoteNodeErrorCode`、`RemoteNodeCloseCodes` | 原先没出包的码表：错误类不出包之后，外面一律按这几张表判 |
| `KernelEnvironmentVariables`、`KernelFileModes`、`KernelRpcLimits`、`RemoteNodeLimits` | 原先没出包的常量表 |
| `createKernelLauncher` | `new KernelLauncher(...)` |
| `createKernelUpdater` | `new KernelUpdater(...)` |
| `createRemoteNodeClient` | `new RemoteNodeClient(...)` |
| `createRemoteNodeServer` | `new RemoteNodeServer(...)` |
| `createRemoteNodeIsolationAdapter` | `new RemoteNodeIsolationAdapter(...)` |
| `createRemoteNodeClientCredentialStore` | `new FileRemoteNodeCredentialStore(defaultRemoteNodeCredentialsPath(slug))` |
| `RemoteNodeClientCredentialStoreOptions` | 上一条的入参形状 |
| `kernelDaemons` | `discoverKernelDaemon` / `connectToKernelDaemon` / `createDefaultKernelDaemonPaths` |
| `KernelWireScopeRef`、`KernelWireCapabilityToken`、`KernelWireCapabilityRequirement`、`KernelWireCapabilityIsolation` | wire 坐标下与 `types/kernel.ts` 同名的四个类型；两套坐标不混用，wire 那套出包时带 `KernelWire` 前缀 |

另外两个不是新名字、但形状变了，也要按破坏性变更对待：

| 名字 | 变化 |
| --- | --- |
| `BootedKernelDaemonApi` | 新增 `createClient(): KernelClientApi` —— 顶替原先出包的 `InProcessKernelTransport` + `KernelClient`；走的是和本机 RPC 完全相同的一条调用路径（INV-9） |
| `KernelDaemonAssemblyOptions` | 新增 `bundledPacks?: readonly KernelBundledPack[]` —— 顶替原先要先调 `createBundledModPack` / `toBundledPackRecords` 的写法，`modPacks`（已是记录形状）照旧可用 |

---

## 3. 有替代的旧名（59）

### 3.1 版本号：全部读版本轴表

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `KernelVersion` | `KernelVersionAxes.kernel` | `.` / `./contracts` | 0 | — |
| `KernelModuleApiVersion` | `KernelVersionAxes.moduleApi` | `.` / `./contracts` | 8（已改完） | Desktop 1 |
| `KernelProtocolVersion` | `KernelVersionAxes.protocol` | `.` / `./contracts` | 0 | Termel 1 |
| `RemoteNodeProtocolVersion` | `KernelVersionAxes.remoteNodeTransport` | `.` / `./contracts` | 0 | — |
| `RemoteNodeModuleApiVersion` | `KernelVersionAxes.moduleApi` | `.` / `./contracts` | 0 | — |
| `RemoteNodeModuleVersion` | 已删无替代（远端代理模块的版本由投影自己定） | — | 0 | — |

### 3.2 模块 SDK：四个顶层函数并成一个实例

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `createCapabilityToken(id, v)` | `kernelModules.token(id, v)` | `.` | 9（已改完） | Desktop 1 |
| `requireCapability(token, range)` | `kernelModules.requirement(token, range)` | `.` | 0 | — |
| `defineKernelModule(m)` | `kernelModules.define(m)` | `.` | 6（已改完） | Desktop 1 |
| `createKernelCallableCapability(ops)` | `kernelModules.callable(ops)` | `.` | 5（已改完） | — |
| `parseVelarosModEnvelope(x, o)` | `velarosModEnvelopes.parse(x, o)` | `.` | 2（已改完） | Desktop 3、Termel 1 |

顶层泛型工厂本身就是门禁拦下来的写法（「公开签名引用了 impl 的类型参数」），所以这四个必须改，
不是审美问题。

### 3.3 类 → 工厂

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `new Kernel(o)` | `createKernel(o)`；类型位用 `KernelApi` | `.` | 0 | Desktop 2、Workbench 4 |
| `new KernelModuleHost(o)` | `createKernel(o)`；`getOptionalService` 由 `kernel.getCapability` 适配 | `.` | 2（已改完） | — |
| `new KernelLauncher(o)` | `createKernelLauncher(o)`；类型位用 `KernelLauncherApi` | `./serve` | 0 | — |
| `new KernelUpdater(o)` | `createKernelUpdater(o)`；类型位用 `KernelUpdaterApi` | `./serve` | 0 | — |
| `new KernelService(o)` + `KernelServiceOptions` | `bootKernelDaemon(...)` 的 `booted.service`（`KernelServiceApi`） | `./serve` / `.` | 0 | — |
| `new KernelClient(t)` | `kernelDaemons.connect()` 的 `connection.client`，或 `booted.createClient()`；类型位用 `KernelClientApi` | `./client` / `./serve` | 0 | Termel 3 |
| `new InProcessKernelTransport(s)` | `booted.createClient()` | `./serve` | 0 | Termel 1 |
| `new SocketKernelTransport(...)` | `kernelDaemons.connect()` 内部自己建 | `./client` | 0 | — |
| `CapabilitySession`（类型位） | `CapabilitySessionApi` | `.` | 0 | Termel 1 |
| `new RemoteNodeClient(o)` | `createRemoteNodeClient(o)`；类型位用 `RemoteNodeClientApi` | `./remote` / `.` | 3（已改完） | Termel 1 |
| `new RemoteNodeServer(o)` | `createRemoteNodeServer(o)`；类型位用 `RemoteNodeServerApi` | `./remote` / `.` | 0 | Termel 1 |
| `new RemoteNodeIsolationAdapter(o)` | `createRemoteNodeIsolationAdapter(o)` | `./remote` | 0 | — |
| `new RemoteNodeProjection(i)` | `createRemoteNodeProjection(i)`（本来就有） | `./remote` | 0 | — |
| `new FileRemoteNodeCredentialStore(p)` | `createRemoteNodeClientCredentialStore({ hostSlug })` | `./remote` | 1（已改完） | — |
| `defaultRemoteNodeCredentialsPath(slug)` | 并进上一条（`path` 选项可覆盖落点） | `./remote` | 1（已改完） | — |
| `new KernelUpdateLock(o)` / `withKernelUpdateLock(o, fn)` | 已删无替代：锁由 `createKernelUpdater` 内部拿 | — | 0 | — |
| `new DenyAllKernelPermissionBroker()` | 不注入即得（`createKernel` 的安全缺省就是 deny-all） | — | 0 | — |
| `new InMemoryKernelStateBackend()` | 不注入即得（缺省就是内存态） | — | 0 | — |
| `new PassthroughKernelArtifactExtractor()` / `new UnverifiedKernelArtifactSignatureVerifier()` | 不注入即得（`createKernelUpdater` 的缺省） | — | 0 | — |

### 3.4 错误类 → 错误码

错误类一律不出包，外面按码判、按 `details` 取现场；`message` 只给人看。
Workbench 用的那三个错误类在上一轮包内改造时就已经不在了，这里一并列出去向。

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `KernelError`、`KernelErrorDetails` | `error.code` 落在 `KernelErrorCodes` / `KernelCallErrorCodes` 里 | `.` / `./contracts` | 0 | — |
| `KernelClientError` | `error.code` 落在 `KernelClientErrorCodes` 里 | `.` / `./contracts` | 0 | — |
| `KernelUpdaterError`、`KernelUpdaterErrorDetails` | `error.code` 落在 `KernelUpdaterErrorCodes` 里 | `.` / `./contracts` | 0 | — |
| `RemoteNodeClientError` | 按 `RemoteNodeClientErrorCodes` 判；形状是公开数据 `RemoteNodeClientFailure`（`code` / `retryable` / `resultUnknown` / `nodeError`） | `.` / `./contracts` | 2（已改完） | — |
| `UnknownKernelCapabilityOperationError` | `error.code === KernelCallErrorCodes.operationNotFound` | `.` / `./contracts` | 0 | Workbench 1 |
| `KernelCapabilityPermissionDeniedError` | `error.code === KernelCallErrorCodes.permissionDenied` | `.` / `./contracts` | 0 | Workbench 1 |
| `KernelCapabilityUnavailableError` | `error.code === KernelCallErrorCodes.capabilityNotFound`（能力不在册）或 `.capabilityNotCallable`（在册但不满足可调用约定） | `.` / `./contracts` | 0 | Workbench 1 |

`capabilityId` / `operation` / `permission` 挂在 `error.details` 上。跨机调用的 `resultUnknown` 把
「没执行」与「可能已半执行」分成两档，重试前必须看它——压成普通失败会诱导调用方重试一次
可能已经跑了一半的远程动作。Platform 仓里的判法可以直接抄 agent 的
`packages/agent/src/utils/connectors/remote-node-mcp.ts::isRemoteNodeClientFailure`。

### 3.5 守护进程发现与装配

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `discoverKernelDaemon(paths?)` | `kernelDaemons.discover(paths?)` | `./client` | 0 | — |
| `connectToKernelDaemon(paths?)` | `kernelDaemons.connect(paths?)` | `./client` | 0 | Termel 1 |
| `createDefaultKernelDaemonPaths(name?)` | `kernelDaemons.defaultPaths(name?)` | `./client` | 0 | — |
| `openCapabilitySessionOnTransport(t, i)` | `client.openCapabilitySession(i)` | `./client` | 0 | — |
| `installKernelShutdownHandlers(booted)` | `booted.installShutdownHandlers()` | `./serve` | 0 | — |
| `createBundledModPack(input)` / `toBundledPackRecords(packs)` / `bundledPackSpecifier(id)` | `bootKernelDaemon({ bundledPacks })` 直接收 `{ id, version, provides, module }` | `./serve` | 0 | — |
| `createManifest(...)` | 已删无替代：`RemoteNodeManifestSource.current()` 只交能力与工具，清单由服务端自己拼 | — | 0 | — |
| `KernelProtocolWireSchemas` | 已删无替代：schema 不出包，见 §4.1 | — | 0 | — |
| `KernelAbi` / `KernelProtocol` 两个命名空间 | 已删无替代：名字直接从 `.` 或 `./contracts` 取，不再套一层命名空间 | — | 0 | — |

### 3.6 只是换了名字的旧别名（`./contract/provides.ts` 里标 ★ 的五个）

| 旧名 | 新名 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `BootedKernelDaemon` | `BootedKernelDaemonApi` | `.` | 0 | Termel 1 |
| `BootKernelDaemonOptions` | `KernelDaemonAssemblyOptions` | `.` | 0 | — |
| `KernelLaunchResult` | `KernelLauncherResult` | `.` | 0 | — |
| `InProcessKernelService` | `InProcessKernelTransportService`（也已不出包，见 §3.3） | — | 0 | — |
| `ConnectedKernelDaemon` | `KernelDaemonDirectoryConnection` | `.` | 0 | — |

---

## 4. 已删、没有替代的名字（229）

这些名字在 0.3.0 里**不再出包**。它们要么是包内实现细节，要么是没有任何公开签名用得到的数据。
需要它们的功能，走 §3 里的替代面。

### 4.1 zod schema 与协议判定（65 + 2）

65 个 `*Schema` 与 `KernelProtocolWireSchemas` 全部不出包；协议判定
`negotiateKernelProtocol`、`isKernelProtocolAccepted`、`KernelProtocolNegotiation` 同。

**数据类型仍然出包**（在 `.`）：`CapabilityCallRequest`、`CapabilityCallResponse`、
`KernelHandshake`、`KernelModuleDescriptor`、`RemoteNodeManifest`、`RemoteNodeToolDescriptor`、
`VelarosModEnvelope` 等 32 个 wire 形状照旧可以叫得出名字，只是没有运行期校验器。

要在包外做运行期校验，只有两条路：

1. 让内核替你解析——`velarosModEnvelopes.parse(...)` 是唯一出包的解析入口；
2. 读构建产物 `packages/kernel/dist/schema-snapshot.json`（JSON Schema，53 条，
   `check:kernel-schemas` 逐字节盯着它与 `baselines/kernel/kernel-wire-schema-snapshot.json` 一致）。

协议版本不匹配时的升级方向不再由 `negotiateKernelProtocol` 给，改为：两端版本必须与
`KernelVersionAxes.protocol` 完全相同，不同就是 `KernelClientErrorCodes.protocolVersionMismatch`，
`error.guidance` 带着升级方向（INV-13）。

### 4.2 内部类（19）与它们的 Api 接口（15）

类：`AllowLoadedKernelClientAccessBroker`、`CapabilitySessionLedger`、
`DenyAllKernelClientAccessBroker`、`DenyAllKernelPermissionBroker`、`InMemoryKernelStateBackend`、
`KernelEventHub`、`KernelLocalDaemon`、`KernelLocalRpcServer`、`KernelModLoader`、`KernelModStore`、
`KernelServiceStore`、`PassthroughKernelArtifactExtractor`、`RemoteNodeCallRunner`、
`RemoteNodeInvocationPool`、`RemoteNodePairingGate`、`RemoteNodePendingCalls`、
`RemoteNodeResultCache`、`ScopedKernelServiceResolver`、`UnverifiedKernelArtifactSignatureVerifier`。

Api 接口：`AllowLoadedKernelClientAccessBrokerApi`、`CapabilitySessionLedgerApi`、
`InProcessKernelTransportApi`、`KernelCapabilityInvokerApi`、`KernelEventHubApi`、
`KernelLocalRpcServerApi`、`KernelModLoaderApi`、`KernelModuleHostApi`、`KernelServiceStoreApi`、
`KernelUpdateLockApi`、`RemoteNodeCallRunnerApi`、`RemoteNodeInvocationPoolApi`、
`RemoteNodePairingGateApi`、`RemoteNodePendingCallsApi`、`RemoteNodeResultCacheApi`。

这些都是 `createKernel` / `bootKernelDaemon` / `createRemoteNode*` 在内部装好的零件，
装配者不需要认识它们。仍然出包的三个装配件接口是 `KernelLocalDaemonApi`、`KernelServiceApi`、
`KernelModStoreApi`——因为 `BootedKernelDaemonApi` 的三个字段就是它们。

### 4.3 utils 零件函数（64）

远程节点的密钥、帧编解码、握手与退避：`createChallenge`、`createClientId`、`createEpoch`、
`createNodeId`、`createPairingCode`、`generateRemoteNodeKeyPair`、`signChallenge`、
`verifyChallengeSignature`、`decodeClientFrame`、`decodeServerFrame`、`sendFrame`、
`planRemoteNodeHandshake`、`planRemoteNodeCloseAction`、`computeReconnectDelayMs`、
`computeManifestRevision`、`createRemoteNodeWebSocket`、`createAbortError`、
`slugifyRemoteHostName`、`namespaceRemoteId`、`namespaceRemoteToolName`。

本机 RPC 与 descriptor：`parseKernelDaemonDescriptor`、`defaultKernelRuntimeDirectory`、
`createDefaultKernelRpcEndpoint`、`decodeKernelRpcRequest`、`requireRecord`、
`requireNonEmptyString`、`rpcFailure`。

宿主零件：`validateManifest`、`resolveKernelModulePlan`、`createScopedPermissionBroker`、
`createNamespacedStateStore`、`satisfiesVersionRange`、`assertSemanticVersion`、`toError`、
`isKernelCallableCapabilityService`、`resolveKernelCapabilityOperationReason`。

更新器：`downloadKernelArtifact`、`createKernelInstallLayout`、`defaultKernelInstallRoot`、
`ensureKernelInstallLayout`、`kernelVersionDirectory`、`kernelArtifactFileName`、
`listKernelInstalledVersions`、`readKernelInstallRecord`、`writeKernelInstallRecord`、
`readKernelActivePointer`、`writeKernelActivePointer`、`parseKernelActivePointer`、
`loadKernelUpdateManifest`、`parseKernelUpdateManifest`、`findKernelManifestVersion`、
`listKernelManifestVersions`、`selectKernelArtifact`、`selectKernelManifestVersion`、
`resolveKernelArtifactTarget`、`fetchKernelText`、`nodeKernelFetch`、`isRemoteKernelUrl`、
`isKernelVersion`、`assertKernelVersion`、`parseKernelVersion`、`compareKernelVersions`、
`satisfiesKernelVersionRange`。

仓库标准的原话：utils 的函数不出包。要这些能力的走 `createKernelUpdater` /
`createRemoteNode*` / `kernelDaemons` 的方法面。

### 4.4 没有公开签名用得到的数据类型与常量（68）

`BoundCapabilityRequirement`、`BundledSpecifierScheme`、`CapabilitySessionRecord`、
`FrameDecodeResult`、`KernelActiveServiceSnapshot`、`KernelArchitecture`、
`KernelArtifactDownloadOptions`、`KernelArtifactDownloadResult`、`KernelArtifactSelection`、
`KernelArtifactTargets`、`KernelCapabilityProvider`、`KernelInstallRecordFileName`、
`KernelInstallRootVariable`、`KernelLocalDaemonOptions`、`KernelLocalRpcServerOptions`、
`KernelManifestLoadOptions`、`KernelManifestQuery`、`KernelModulePlan`、`KernelPlatform`、
`KernelProtocolNegotiation`、`KernelRpcError`、`KernelRpcEventFrame`、`KernelRpcFailure`、
`KernelRpcRequest`、`KernelRpcResponse`、`KernelRpcServerFrame`、`KernelRpcSuccess`、
`KernelSemanticVersion`、`KernelUpdateLockOptions`、`KernelUpdateLockRecord`、
`KernelVersionPattern`、`LoadModsResult`、`MaximumKernelManifestBytes`、
`NamespacedKernelStateStoreOptions`、`RemoteNodeAuthenticate`、`RemoteNodeCallRunnerOptions`、
`RemoteNodeCancel`、`RemoteNodeChallenge`、`RemoteNodeClientErrorInit`、`RemoteNodeClientFrame`、
`RemoteNodeCloseAction`、`RemoteNodeCloseCodeValue`、`RemoteNodeFatal`、
`RemoteNodeHandshakeInput`、`RemoteNodeHandshakeStep`、`RemoteNodeHeartbeatIntervalMs`、
`RemoteNodeHello`、`RemoteNodeIdleTimeoutMs`、`RemoteNodeInvoke`、`RemoteNodeKeyPair`、
`RemoteNodeManifestChanged`、`RemoteNodeMaxFrameBytes`、`RemoteNodePair`、`RemoteNodePaired`、
`RemoteNodePairingGateOptions`、`RemoteNodePairingLifetimeMs`、`RemoteNodePairingLockoutMs`、
`RemoteNodePairingMaxFailures`、`RemoteNodePendingCallsHost`、`RemoteNodePing`、`RemoteNodePong`、
`RemoteNodeProgress`、`RemoteNodeProgressEvent`、`RemoteNodeReady`、`RemoteNodeResult`、
`RemoteNodeServerFrame`、`ScopedKernelPermissionBrokerOptions`、`SocketKernelTransportOptions`。

四个调优上限（`RemoteNodeHeartbeatIntervalMs`、`RemoteNodeIdleTimeoutMs`、
`RemoteNodeMaxFrameBytes`、`RemoteNodePairing*`）在 `RemoteNodeLimits` 这张常量表里还能查到，
只是不再各自一个名字。

---

## 5. 三个产品仓要改的调用点

逐文件列出**实际的 import 语句**（源文件里真的写了 `@velaros-ai/kernel*` 的那些；注释与文档不算）。
Desktop 16 个文件、Workbench 6 个、Termel 7 个。

### 5.1 VelarOS-Desktop（16 个文件）

| 文件 | 现在从哪取什么 | 改成 |
| --- | --- | --- |
| `src/main/bootstrap/Composition.ts` | `/runtime`: `Kernel` | `createKernel` from `@velaros-ai/kernel`；`new Kernel(o)` → `createKernel(o)` |
| `src/main/bootstrap/RuntimeTypes.ts` | `/contracts/abi`: `KernelModuleDefinition` | `@velaros-ai/kernel`（`Kernel` 的类型位改 `KernelApi`） |
| `src/main/kernel/ModCapabilityBroker.ts` | `/contracts/abi`: `KernelCallableCapabilityService`、`KernelPermissionDecision` | 前者 `@velaros-ai/kernel`，后者 `@velaros-ai/kernel/contracts` |
| `src/main/kernel/ModPermissionBroker.ts` | `/contracts/abi`: `KernelPermissionBroker`、`KernelPermissionDecision`、`KernelPermissionRequest` | broker 接口 `@velaros-ai/kernel`，两个数据 `@velaros-ai/kernel/contracts` |
| `src/main/kernel/ExternalModCommandRuntime.ts` | `/contracts/abi`: `KernelPermissionBroker` | `@velaros-ai/kernel` |
| `src/main/kernel/ExternalModHookBindings.ts` | `/contracts/protocol`: `parseVelarosModEnvelope` | `velarosModEnvelopes.parse` from `@velaros-ai/kernel` |
| `src/main/kernel/ExternalModToolBindings.ts` | 同上 | 同上 |
| `src/main/storage/kernel/AgentModPackStore.ts` | `/contracts/protocol`: `VelarosModManifestFileName`、`parseVelarosModEnvelope` | 常量 `@velaros-ai/kernel/contracts`；解析 `velarosModEnvelopes.parse` from `@velaros-ai/kernel` |
| `src/main/storage/kernel/ModMarketStaging.ts` | `/contracts/protocol`: `VelarosModManifestFileName` | `@velaros-ai/kernel/contracts` |
| `src/main/storage/kernel/DesktopKernelStateBackend.ts` | `/runtime`: `KernelStateBackend` | `@velaros-ai/kernel` |
| `src/mods/mainRegistry.ts` | `/contracts/abi`: `KernelCallableCapabilityService`、`KernelModuleApiVersion`、`KernelModuleDefinition`、`KernelStateStore`、`createCapabilityToken`、`defineKernelModule` | 三个接口与 `kernelModules` from `@velaros-ai/kernel`；`KernelVersionAxes.moduleApi` from `@velaros-ai/kernel/contracts`；两个函数改 `kernelModules.token` / `.define` |
| `src/mods/memory/main/StoreRegistry.ts` | `/contracts/abi`: `CapabilityToken` | `@velaros-ai/kernel/contracts` |
| `scripts/checks/kernelAssembly.mjs` | `/runtime`: `Kernel` | `createKernel` from `@velaros-ai/kernel`（这是门禁脚本里的真 import） |
| `tests/maintained/src/main/kernel/ExternalModHookBindings.test.ts` | `/contracts/abi`: `KernelPermissionBroker` | `@velaros-ai/kernel` |
| `tests/maintained/src/main/kernel/ExternalModToolBindings.test.ts` | 同上 | 同上 |
| `tests/maintained/src/main/storage/ModMarketStagingSkillSpaces.test.ts` | `/contracts/protocol`: `VelarosModManifestFileName` | `@velaros-ai/kernel/contracts` |

另外要改但不是 import 的：`tsconfig.node.json` 与 `tsconfig.web.json` 里 `@velaros-ai/kernel/*`
的 paths（收成五条）、`package.json` 与 `bun.lock` 的版本（`^0.4.0`）、
`scripts/build/mainBundledPlatformPackages.json`，以及
`packages/arch-guard-velaros/src/checks/architecture/memoryProductBoundary.ts` 里按 specifier
字符串判断的那几条规则。

### 5.2 VelarOS-Workbench（6 个文件）

| 文件 | 现在从哪取什么 | 改成 |
| --- | --- | --- |
| `src/main/index.ts` | `/runtime`: `Kernel` | `createKernel` from `@velaros-ai/kernel` |
| `src/main/kernel/kernelHostProbe.ts` | `/runtime`: `Kernel` | 同上；类型位 `KernelApi` |
| `src/main/kernel/WorkbenchKernelIpc.ts` | `/runtime`: `Kernel`、`KernelCapabilityPermissionDeniedError`、`KernelCapabilityUnavailableError`；`/contracts/abi`: `ScopeRef`、`UnknownKernelCapabilityOperationError` | `createKernel` / `KernelApi` from `@velaros-ai/kernel`；`ScopeRef` from `@velaros-ai/kernel/contracts`；**三处 `instanceof` 改按码判**：`KernelCallErrorCodes.permissionDenied` / `.capabilityNotFound` / `.operationNotFound`，现场在 `error.details` |
| `src/main/kernel/WorkbenchKernelPermissionPolicy.ts` | `/contracts/abi`: `KernelPermissionBroker`、`KernelPermissionDecision`、`KernelPermissionRequest` | broker 接口 `@velaros-ai/kernel`，两个数据 `@velaros-ai/kernel/contracts` |
| `tests/workbench-agent-capability-runtime.test.ts` | `/runtime`: `Kernel`；`/contracts/abi`: `KernelEvent` | `createKernel` from `@velaros-ai/kernel`；`KernelEvent` from `@velaros-ai/kernel/contracts` |
| `package.json` / `bun.lock` | 依赖版本 | `^0.4.0` |

### 5.3 VelarOS-Termel（7 个文件）

| 文件 | 现在从哪取什么 | 改成 |
| --- | --- | --- |
| `packages/serve-host/src/host.ts` | `/serve`: `bootKernelDaemon`、`BootedKernelDaemon`、`InProcessKernelTransport`、`createDefaultKernelModStorePaths`；`/client`: `KernelClient`；`/client/contracts`: `KernelRpcEndpoint` | `bootKernelDaemon` 留在 `./serve`；**`createDefaultKernelModStorePaths` 已删**，`modStorePaths: createDefaultKernelModStorePaths(paths.modsRoot)` 整行改成 `modsRoot: paths.modsRoot`（0.4.0，见 §6）；`BootedKernelDaemonApi` 从 `.` 取；`new KernelClient(new InProcessKernelTransport(booted.service))` → `booted.createClient()`；`KernelRpcEndpoint` 从 `./contracts` 取 |
| `packages/serve-host/src/attached-host.ts` | `/client`: `KernelClient`、`connectToKernelDaemon` | `kernelDaemons.connect()` from `./client`；类型位 `KernelClientApi` from `.` |
| `packages/serve-host/src/data-root.ts` | `/client/contracts`: `KernelDaemonPaths` | `@velaros-ai/kernel/contracts` |
| `packages/serve-host/src/permission-policy.ts` | `/contracts/abi`: `KernelPermissionBroker`、`KernelPermissionDecision`、`KernelPermissionRequest` | broker 接口 `.`，两个数据 `./contracts` |
| `packages/serve-host/src/remote-node.ts` | `/remote/node`: `RemoteNodeServer`、`createRemoteNodeFileAuditLog`、`createRemoteNodeFileCredentialStore`、`RemoteNodeAuditSink`、`RemoteNodeCapabilityInvoker`、`RemoteNodeCapabilityInvokeRequest`、`RemoteNodeCapabilityInvokeResult`、`RemoteNodeCredentialStore`、`RemoteNodeManifestSource`、`RemoteNodeActivityEvent`、`RemoteNodePairedCredential`；`/remote`: `createManifest`；`/contracts/protocol`: `KernelModuleDescriptor`、`RemoteNodeCapabilityDescriptor`、`RemoteNodeManifest`、`RemoteNodeToolDescriptor` | 值：`createRemoteNodeServer`、`createRemoteNodeAuditLog`、`createRemoteNodeServerCredentialStore`，全在 `./remote`；`RemoteNodeCredentialStore` 改叫 `RemoteNodeServerCredentialStore`；其余类型全从 `.` 取；**`createManifest` 已删无替代**，清单改由 `RemoteNodeManifestSource.current()` 交能力与工具、服务端自己拼 |
| `packages/serve-host/src/tool-gateway.ts` | `/client`: `CapabilitySession`、`KernelClient`、`KernelProtocolVersion`；`/contracts/protocol`: `CapabilityCallResponse`、`ScopeRef` | 类型位 `CapabilitySessionApi` / `KernelClientApi` from `.`；`KernelVersionAxes.protocol` from `./contracts`；`CapabilityCallResponse` from `.`；**wire 的 `ScopeRef` 改叫 `KernelWireScopeRef`**（从 `.` 取，别和 `types/kernel.ts` 的 `ScopeRef` 混用） |
| `packages/serve-host/test/remote-node.e2e.test.ts` | `/remote/client`: `RemoteNodeClient`、`RemoteNodeCredentials` | `createRemoteNodeClient` from `./remote`；`RemoteNodeCredentials` from `.` |
| `packages/termel-runtime/src/plugins.ts` | `/contracts/protocol`: `VelarosModManifestFileName`、`parseVelarosModEnvelope` | 常量 `./contracts`；解析 `velarosModEnvelopes.parse` from `.` |

两个 `package.json`（`serve-host`、`termel-runtime`）与 `bun.lock` 的依赖版本提到 `^0.4.0`。

## 6. 0.4.0：`./serve` 收窄到四个值（已完成）

0.3.0 时 `./serve` 上还留着六个 ModStore / Loader 的装配零件函数，是方案 §2.6 的已知偏离；
0.4.0 做掉了。三种去向：真正的实例行为变成 `KernelModStoreApi` 上的方法；本来就只是转发壳的
直接删；纯路径计算退回包内 utils，由一个新选项顶替。`./serve` 现在只有四个值——
`bootKernelDaemon`、`kernelDaemonProcess`、`createKernelLauncher`、`createKernelUpdater`，
全是部署组合的入口。

| 旧名（0.3.0 的 `./serve`） | 新写法（0.4.0） | 为什么 |
| --- | --- | --- |
| `installModPackFromDirectory(store, dir)` | `store.installFromDirectory(dir)` | 读清单、登记、落盘全是仓库自己的事；装完照旧随手落盘，调用方不用再补一次 `persistModIndex` |
| `loadModIndexIntoStore(store)` | `store.loadPersistedIndex()` | 同上。原先的第二个参数（覆盖 paths）没有任何调用点，一并删掉 |
| `persistModIndex(store)` | `store.persistIndex()` | 同上 |
| `registerSystemModPacks(store, packs)` | `store.registerSystem(packs)` | 它本来就只是转发给同名方法的壳，没有自己的逻辑 |
| `registerBundledPacks(store, packs)` | `store.registerBundled(packs)` | 同上 |
| `createDefaultKernelModStorePaths(root)` | **不出包了**；`bootKernelDaemon` 的选项由 `modStorePaths` 换成 `modsRoot: string` | 它是纯路径计算，按仓库标准归 utils（`utils/serve/mod-index.ts` 的 `toModStorePaths`，包内用）。目录布局是内核自己的决定，宿主只交一个数据根，不该替内核拼路径 |

拿到 `KernelModStoreApi` 的口子只有一个：`bootKernelDaemon(...)` 返回的 `booted.modStore`。

两处跟着改形：

| 名字 | 变化 |
| --- | --- |
| `KernelDaemonAssemblyOptions.modStorePaths?: KernelModStorePaths` | 换成 `modsRoot?: string`。用户 pack 永远落在 `<root>/mods`，索引永远落在 `<root>/mod-index.json`；原先把两条路径拆开给（或者只给 `userModsDirectory`、以此关掉持久化）的写法没有了 |
| `KernelModStorePaths` | 还出包，位置从类上方接口挪到 `types/serve.ts` 的纯数据；现在只用来读 `booted.modStore.paths` |

### 跨仓：只有 Termel 一处

`VelarOS-Termel` 的 `packages/serve-host/src/host.ts` 是唯一调过这六个名字的产品仓代码，
调的是 `createDefaultKernelModStorePaths`，两行跟改：

1. 第 13-18 行的 import 里删掉 `createDefaultKernelModStorePaths` 一行，其余不动：

   ```ts
   import {
     type BootedKernelDaemon,
     bootKernelDaemon,
     InProcessKernelTransport,
   } from '@velaros-ai/kernel/serve'
   ```

   这里只画 0.4.0 这一刀。Termel 还停在 0.2.3，`BootedKernelDaemon` 与
   `InProcessKernelTransport` 要按 §5.3 一起改（前者换成 `.` 的 `BootedKernelDaemonApi`，
   后者换成 `booted.createClient()`）——两刀一次做完即可。

2. `bootKernelDaemon({ … })` 里的这一行

   ```ts
   modStorePaths: createDefaultKernelModStorePaths(paths.modsRoot),
   ```

   逐字改成

   ```ts
   modsRoot: paths.modsRoot,
   ```

`attached-host.ts`、`data-root.ts`、`permission-policy.ts`、`remote-node.ts`、`tool-gateway.ts`
与 `termel-runtime/src/plugins.ts` 这一轮不受影响，按第 5.3 节改 0.3.0 那一次即可。

---

## 7. 跨仓：wire schema 产物路径又变了一次

`VelarScript-Libraries` 的 `packages/contract-codegen/tests/support/platform.mjs:20` 与
`tests/real-targets/kernel.manifest.json` 都钉着
`packages/kernel/dist/contracts/protocol/index.js`。这个路径在上一轮「取消 `src/exports/`」时
已经变成 `dist/contracts-protocol.js`，本轮那个入口整个删掉了。

最终状态：**没有任何一条对外入口再导出 zod schema**。contract-codegen 有两条路可选：

1. **按文件读实现产物**（最贴近它现在的做法，`resolveFrom` 是本地 checkout，不经 package exports）：
   把一个 module 条目拆成五个，分别指
   `./dist/utils/wire/capability.js`（18 条）、`./dist/utils/wire/remote-node.js`（23 条）、
   `./dist/utils/wire/mods.js`（8 条）、`./dist/utils/wire/mod-envelope.js`（4 条）、
   `./dist/utils/wire/handshake.js`（1 条）——合计 54 条，比快照多的那一条是
   `RemoteNodePlatformSchema`（快照不单列它，它只作为别的帧的字段出现）。
   这五个文件各自导出 `*Schema` 顶层名，
   `stripSuffix: "Schema"` 照旧成立；`./dist/utils/wire/negotiation.js` 与 `version.js` 里没有
   schema，`./dist/utils/wire/snapshot.js` 只导出 `KernelProtocolWireSchemas` 一个对象，
   `exports: "all"` 在它身上拿不到逐个 schema。
2. **改读 JSON Schema 快照** `./dist/schema-snapshot.json`（53 条，构建时由
   `packages/kernel/scripts/generate-schema-snapshot.mjs` 生成，`check:kernel-schemas` 盯着它与
   `baselines/kernel/kernel-wire-schema-snapshot.json` 逐字节一致）。这条更稳：它是审过的基线，
   不随实现文件挪动而漂。

第 1 条是零改造的最短路径，第 2 条是长期正确的那条。两条都不需要 Platform 仓再改什么。
`agent.manifest.json` 那一条（`packages/agent/dist/protocol/index.js`）本轮没动。
