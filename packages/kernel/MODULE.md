# @velaros-ai/kernel 模块卡片

读这份卡片的顺序：先看「这是什么」与「提供什么」，再看「骨干链路」里每件能力怎么被回答，
需要时看「结构」里的目录树与分层。类的实现、数据字段与工具函数的内部一般不用看。

标准见 `docs/architecture/module-ownership.md`，改造方案见 `docs/engineering/refactor-plans/kernel.md`。

## 这是什么

VelarOS 的库优先微内核。它只理解四件事：模块生命周期、能力寻址、作用域句柄、调用信封；
**不认识任何具体能力**——文件、浏览器、记忆、项目这些全是装进来的模块。

一份实现，四种部署形态：进程内内核（根入口）、自己起守护进程（`./serve`）、
附着到已运行守护进程的瘦客户端（`./client`）、跨机的远程能力节点两端（`./remote`）。
四种形态共用同一条能力调用路径与同一份 wire 协议，不许各写一遍。

没有模型面工具：内核不定义工具，工具由装进来的能力包定义。

## 提供什么

`OperationReadContract`：能力返回值的资源版本捕获和只读验证。

`approvalContracts`、`defaultDenyApprovalPort`、`createTaskApprovalState`：审批身份、默认拒绝及任务内批准/拒绝/撤销账本。接口：`ApprovalPort`、`ApprovalContractsApi`、`TaskApprovalStateApi`。

`ModelDriver` 是宿主提供的中立模型端口；`modelRequestEncoder` / `ModelRequestEncoderApi` 定义最终材料的统一文本编码。Agent 依赖这个端口，Model 提供供应商适配。


五个入口。`.` 与 `./contracts` 任何环境都能加载（渲染进程也能）；
`./client`、`./serve`、`./remote` 是 Node 专用。

| 入口 | 给谁 | 运行环境 |
| --- | --- | --- |
| `.` | 八个能力包写内核模块；Desktop / Workbench 装进程内内核 | 任何环境 |
| `./contracts` | 任何进程拿可移植的契约数据与常量表 | 任何环境 |
| `./client` | 附着到已运行守护进程的产品 | Node |
| `./serve` | 自己起守护进程的宿主、可执行文件、装或升级共享 Runtime 的产品 | Node |
| `./remote` | 远程能力节点两端的装配方 | Node + `ws` |

`./contracts` 是 `.` 的可移植子集（常量表 + `types/kernel.ts`）：只要数据不要值的调用方认它，
拿值（造内核、写模块、起守护进程）一律从根入口取。

<!-- 名字清单：门禁要求每个导出的值与每个公开接口都在这一节里出现 -->

### 公开接口

- `OperationContext`、`OperationDefinition`、`OperationModuleDefinition`、`InvocationJournal`、`OperationRuntimeOptions`、`OperationRuntimeApi`：统一模块定义、发现、schema 校验、参数准备与持久调用回执。

- `BootedKernelDaemonApi`、`CapabilitySessionApi`、`KernelApi`、`KernelArtifactExtractor`
- `KernelArtifactSignatureVerifier`、`KernelCallableCapabilityOperation`、`KernelCallableCapabilityService`、`KernelCapabilityOperationContext`
- `KernelCapabilityOperationMetadata`、`KernelCapabilityOperationReason`、`KernelClientAccessBroker`、`KernelClientApi`
- `KernelClientEventHandler`、`KernelClientTransport`、`KernelDaemonAssemblyOptions`、`KernelDaemonDirectoryApi`
- `KernelDaemonDirectoryConnection`、`KernelDaemonProcessApi`、`KernelDaemonProcessEnvironment`、`KernelEventHandler`
- `KernelEventSubscription`、`KernelFetch`、`KernelHealthCheck`、`KernelLauncherApi`
- `KernelLauncherOptions`、`KernelLauncherResult`、`KernelLocalDaemonApi`、`KernelModStoreApi`
- `KernelModStorePaths`、`KernelModuleActivateContext`、`KernelModuleDefinition`、`KernelModuleEventBus`
- `KernelModuleHostOptions`、`KernelModuleImporter`、`KernelModuleIsolationAdapter`、`KernelModuleKitApi`
- `KernelModuleLifecycle`、`KernelModulePermissionBroker`、`KernelOptions`、`KernelPermissionBroker`
- `KernelRegistration`、`KernelServiceApi`、`KernelServiceHandle`、`KernelServiceResolver`
- `KernelStateBackend`、`KernelStateStore`、`KernelUpdaterApi`、`RemoteNodeActivitySink`
- `RemoteNodeAuditSink`、`RemoteNodeCapabilityInvoker`、`RemoteNodeClientApi`、`RemoteNodeClientCredentialStore`
- `RemoteNodeIsolationAdapterOptions`、`RemoteNodeManifestSource`、`RemoteNodeProjectionApi`、`RemoteNodeServerApi`
- `RemoteNodeServerCredentialStore`、`RemoteNodeSocket`、`RemoteNodeSocketFactory`、`VelarosModEnvelopeApi`

### 导出的值

- `createOperationRuntime`：使用已有 Kernel 模块生命周期和能力调用器，配合可靠日志创建调用主链。

- `KernelCallErrorCodes`、`KernelClientErrorCodes`、`KernelEnvironmentVariables`、`KernelErrorCodes`
- `KernelFileModes`、`KernelModuleIsolationValues`、`KernelModuleIsolations`、`KernelRpcLimits`
- `KernelRpcMethods`、`KernelUpdaterErrorCodes`、`KernelVersionAxes`、`RemoteNodeClientErrorCodes`
- `RemoteNodeCloseCodes`、`RemoteNodeErrorCodes`、`RemoteNodeLimits`、`RemoteNodeProgressEventType`
- `RemoteNodeSocketPath`、`VelarosModManifestFileName`、`bootKernelDaemon`、`createKernel`
- `createKernelLauncher`、`createKernelUpdater`、`createRemoteNodeAuditLog`、`createRemoteNodeClient`
- `createRemoteNodeClientCredentialStore`、`createRemoteNodeIsolationAdapter`、`createRemoteNodeProjection`、`createRemoteNodeServer`
- `createRemoteNodeServerCredentialStore`、`kernelDaemonProcess`、`kernelDaemons`、`kernelModules`
- `velarosModEnvelopes`

## 骨干链路

内核没有工具，这一节写每件能力怎么被回答。

- **装一个进程内内核**：`createKernel(options)` 建一份 `KernelModuleHost` 与一份
  `KernelCapabilityInvoker` → `registerModule` 逐个登记 →`start()` 解析依赖图（`resolveKernelModulePlan`）
  → 按序 `activate` → 全部 `ready`。失败按 `lifecycleFailureMode` 抛或降级。
- **调一件能力**：`kernel.invokeCapability(call)` → `KernelCapabilityInvoker.invoke`：
  解析活动令牌（`KernelServiceStore.getActiveToken`）→ 认可调用面（`isKernelCallableCapabilityService`）
  → 取操作元数据（未知操作在此失败）→ 算权限理由 → 逐条过 `KernelPermissionBroker`
  → 才进 provider 代码。进程内与 serve 走的是同一个 `KernelCapabilityInvoker`（INV-9）。
- **写一个内核模块**：`kernelModules.token / requirement / define / callable` 四件套；
  激活时拿到的 `KernelModuleActivateContext` 是收窄过的宿主面，身份与代际伪造不了。
- **起守护进程**：`bootKernelDaemon(options)` → `KernelDaemonAssembly` 装 ModStore、Loader、
  宿主、`KernelService`、`KernelLocalDaemon` → 拿单实例锁 → 起本机 RPC → 写 descriptor。
  可执行文件走 `kernelDaemonProcess.run({ environment })`（`bin/velaros-kernel-daemon.mjs`）。
  不过网络的进程内客户端由 `booted.createClient()` 给，走的是同一条调用路径（INV-9）。
  mod 的登记、安装与索引读写全在 `booted.modStore`（`KernelModStoreApi`）上，`./serve` 不另出零件函数。
- **附着到已运行的守护进程**：`kernelDaemons.discover()` 读 descriptor → `kernelDaemons.connect()`
  建传输与客户端 → `openCapabilitySession(requires)` 绑能力
  → `session.call(...)`。会话外的调用一律 `CAPABILITY_NOT_GRANTED`（INV-14）。
- **装一台远程节点**：Node 侧 `createRemoteNodeServer(options).start()` 监听、配对、认证、派发；
  Client 侧 `createRemoteNodeClient(options).connect()` 握手拿清单，
  `createRemoteNodeProjection(...)` 把清单投影成本地代理模块，
  `createRemoteNodeIsolationAdapter(...)` 让宿主把它们当 `isolation: 'remote'` 的模块装上。
- **装或升级共享 Runtime**：`createKernelUpdater(options)` → 取清单、核对大小与 SHA-256、
  落位安装、原子改名、健康检查不过就回滚指针（INV-21）。

## 依赖什么

- `@velaros-ai/core`：日志、断言式类型判定、原子写、计时器作用域。
- `zod`：wire schema 的运行期校验（类型手写在 `types/wire.ts`，schema 用 `satisfies` 反向守）。
- `ws` 与 `node:http`：只有 `./remote` 这一条入口用；进程内宿主不会加载它们。
- Node 内置模块（`node:net`、`node:fs`、`node:crypto`、`node:child_process`）：只出现在
  `./serve`、`./client`、`./remote` 的引用链里；根入口与 `./contracts` 不碰（INV-11）。

内核**不依赖任何能力包**：依赖方向单向，能力包引内核，内核不引它们。

## 状态归谁

- 模块图、代际、服务登记表、事件订阅：`KernelModuleHost` 持有，进程内唯一。
- 模块状态（`KernelStateStore`）：命名空间绑死成模块 id，落盘由宿主注入的
  `KernelStateBackend` 负责；不注入就只活在内存里。
- 能力会话账本：`CapabilitySessionLedger`，随连接生灭，不跨连接。
- mod 索引与 pack 记录：`KernelModStore`，落在 ModStore 的用户索引文件里。
- 远程节点凭据与审计：文件存储在宿主给的目录下，权限 0600 / 0700。
- 更新器的版本目录与激活指针：安装根（`VELAROS_KERNEL_HOME`）下。

内核自己**没有全局可变状态**：所有状态都挂在某个实例上，一个进程里可以并存多个内核。

## 生命周期

`idle → starting → ready`（失败则 `degraded`）→ `disposing → disposed`。

- `start()` 与 `dispose()` 都幂等，只真正跑一次。
- 启动分两趟：先按依赖序全部 `activate`，再按同一顺序全部 `ready`；任一趟失败都按逆序回滚已激活的。
- `replaceModule` 是暂存门：新代在门后激活并就绪，其间旧代照常提供服务；成功后同步切换可见性与
  事件归属，再释放旧代；失败只丢掉新代（INV-6）。
- 守护进程的停机由 `kernelDaemonProcess` 装的信号处理负责：先停 daemon 再停 service，最后放锁。

## 失败语义

错误类不出包，外面一律**按码判断**，`message` 只给人看。四张码表在 `contract/constants.ts`：

| 码表 | 谁抛 | 典型码 |
| --- | --- | --- |
| `KernelErrorCodes` | 模块宿主、mod 目录 | `INVALID_MANIFEST`、`CYCLIC_DEPENDENCY`、`MODULE_STATE` |
| `KernelCallErrorCodes` | 能力调用（进程内与 wire 同码） | `OPERATION_NOT_FOUND`、`PERMISSION_DENIED`、`CAPABILITY_NOT_GRANTED` |
| `KernelClientErrorCodes` | 瘦客户端、启动器、本机 RPC | `TRANSPORT_CLOSED`、`DAEMON_NOT_RUNNING`、`PROTOCOL_VERSION_MISMATCH` |
| `KernelUpdaterErrorCodes` | 更新器 | `DIGEST_MISMATCH`、`HEALTH_CHECK_FAILED`、`UPDATE_LOCK_HELD` |
| `RemoteNodeErrorCodes` / `RemoteNodeClientErrorCodes` | 远程节点两端 | `NODE_RESTARTED`、`REMOTE_NODE_PAIRING_REQUIRED`、`DEADLINE_EXCEEDED` |

出事的能力 id、操作名、权限位、拒绝原因挂在错误的 `details` 上。
跨机调用的 `resultUnknown` 把「没执行」与「可能已半执行」分成两档，重试前必须看它。

## 不变量

共 23 条，登记在 `spec/invariants.md`：测试 14 条（`spec/acceptance.test.ts`）、门禁 5 条、类型 1 条、
文字 3 条。未验证 3 条——远程节点的 INV-17 到 INV-19 本仓没有实现测试，由 Termel 仓的
`remote-node.e2e.test.ts` 跨仓覆盖，补上本仓测试之前一律算未验证。

## 非目标

- 不认识任何具体能力：内核里不许出现文件、浏览器、记忆、项目这些域词。
- 不做会话权威：会话住在产品的 renderer 里，内核只回答一次次调用。
- 不做能力市场与安装 UI：ModStore 只管索引与装载，界面归产品。
- 不做跨版本 wire 迁移：协议只接受完全相同的版本，变了就提版本（INV-13）。
- 不做第三方 semver 依赖：范围判定必须在每台宿主上得到同一个结论，所以自带一份确定性实现。

## 结构

```text
packages/kernel/
  MODULE.md                       本卡片
  bin/velaros-kernel-daemon.mjs   守护进程可执行入口（在 src 之外，只取 kernelDaemonProcess 跑起来）
  spec/  invariants.md  acceptance.test.ts
  test/                           实现测试
  src/
    contract/  provides.ts  requires.ts  constants.ts
    types/     kernel.ts（可移植）  wire.ts  runtime.ts  serve.ts  client.ts  updater.ts  remote-*.ts
    impl/      runtime/  serve/  client/  updater/  remote-client/  remote-node/
    utils/     tuning.ts  errors.ts  semver.ts  fs.ts
               runtime/  wire/  rpc/  serve/  updater/  remote/
    index.ts               `.` 入口，只转发
    contracts.ts           `./contracts` 入口，只转发
    client.ts              `./client` 入口，只转发
    serve.ts               `./serve` 入口，只转发
    remote.ts              `./remote` 入口，只转发
```

分层（登记在 `scripts/ownership/governed-modules.mjs` 的 `layers`，上层可以引下层，下层不许引上层）：

| 层 | 目录 | 说明 |
| --- | --- | --- |
| 1 进程侧装配 | `impl/serve/` | 协议服务面、守护进程、本机 RPC、mod 仓库与装载、进程内传输、启动器 |
| 2 部署件 | `impl/client/`、`impl/updater/`、`impl/remote-client/`、`impl/remote-node/` | 瘦客户端、更新器、远程节点两端；互不依赖 |
| 3 进程内内核 | `impl/runtime/` | 模块宿主、唯一调用路径、模块 SDK、mod 信封解析；不碰 Node 模块 |

线性分层表达不了的三条（client 不引 runtime / serve、remote 两侧互不引用、updater 只引根 utils），
由 `check:kernel-arch` 按目录核（INV-12）。utils 在所有层之下，只引 utils、types 与合同。

## ScriptAct 中立合同

`OperationSurface` 承载领域生成的声明、schema、模板和版本，经 `OperationModuleDefinition.surface` 装配。注册时核对身份与操作合同，避免声明/执行漂移。schema 支持局部 definitions/$ref、递归和固定元组，外部引用拒绝。

`OperationContext.attach` 以统一 `ModelImage` 合同收集图像，持久回执保存附件；`ModelTurnRequest.images` 与 `ModelUserMessage` 通过 `modelRequestEncoder.messages` 进入实际请求，编译器和供应商适配器使用同一编码。边界校验格式、数量和容量。
