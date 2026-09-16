/**
 * 内核对外约定的常量表：版本轴、身份字符串、错误码、环境变量名、协议上限。
 *
 * 这里只放冻结表与字符串身份；可调的数字（超时、重试、缓冲）在 `utils/tuning.ts`，
 * 类自己固定用的写成类内 `private static readonly`。
 */

/**
 * 四根独立演进的版本轴。
 *
 * - `kernel`：完整内核宿主对 mod 清单自报的版本，即 `engines.velaros` 那一轴；
 *   刻意与 npm 包版本、wire 协议版本分开。
 * - `moduleApi`：模块清单 ABI，内核宿主只认这一个数。
 * - `protocol`：本机 RPC 的 wire 协议主版本；每个版本只接受完全相同的 wire 版本，
 *   协议一变直接提版本，旧数据不在运行时迁移。
 * - `remoteNodeTransport`：远程节点帧协议版本，与本机 RPC 各走各的。
 */
export const KernelVersionAxes = Object.freeze({
  kernel: '0.3.0',
  moduleApi: 1,
  protocol: 2,
  remoteNodeTransport: 1,
})

/**
 * 部署决策的唯一表达位（宪章 §15 原则一 / Ring 0 第 9 项）。
 *
 * 默认 `in-process`，装配者选，内核不预设；`remote` 表示 provider 住在另一台机器上，
 * 由宿主注入的隔离适配器负责传输与生命周期映射。descriptor 校验、wire schema 与 mod
 * 信封都读这一份，谁也不许再抄一遍字面量数组。
 */
export const KernelModuleIsolations = Object.freeze({
  inProcess: 'in-process',
  worker: 'worker',
  remote: 'remote',
})

/** mod 清单在包里的固定文件名；打包、导入、市场三条路都按它找清单。 */
export const VelarosModManifestFileName = 'velaros.mod.json'

/** 模块宿主自己抛出的失败；外面按码判断，文字只给人看。 */
export const KernelErrorCodes = Object.freeze({
  /** 模块清单声明的 ABI 版本与本宿主认的那一个对不上。 */
  apiVersionMismatch: 'API_VERSION_MISMATCH',
  /** 依赖图成环，排不出启动顺序。 */
  cyclicDependency: 'CYCLIC_DEPENDENCY',
  /** 同一个能力 id 被两个模块声明提供。 */
  duplicateCapability: 'DUPLICATE_CAPABILITY',
  /** 同一个模块 id 注册了两次。 */
  duplicateModule: 'DUPLICATE_MODULE',
  /** 同一代里同一个能力被注册了两次服务。 */
  duplicateService: 'DUPLICATE_SERVICE',
  /** 内核已回收，之后的任何操作都不做。 */
  hostDisposed: 'HOST_DISPOSED',
  /** 模块清单本身不合法（id、版本、令牌形状不对）。 */
  invalidManifest: 'INVALID_MANIFEST',
  /** 注册的服务不是对象，或不满足能力约定。 */
  invalidService: 'INVALID_SERVICE',
  /** 版本号不是合法的 x.y.z。 */
  invalidVersion: 'INVALID_VERSION',
  /** 版本范围写法不合法。 */
  invalidVersionRange: 'INVALID_VERSION_RANGE',
  /** 模块声明必需的能力，但没有模块提供它。 */
  missingCapability: 'MISSING_CAPABILITY',
  /** 模块声明的隔离形态在本次装配里没有对应的适配器。 */
  missingIsolationAdapter: 'MISSING_ISOLATION_ADAPTER',
  /** 能力活着但这一代没有注册服务。 */
  missingService: 'MISSING_SERVICE',
  /** 模块生命周期出错：激活、就绪、挂起、释放任一阶段失败。 */
  moduleState: 'MODULE_STATE',
  /** 模块访问了自己没声明过的能力。 */
  undeclaredCapabilityAccess: 'UNDECLARED_CAPABILITY_ACCESS',
  /** 模块注册了自己没声明提供的能力。 */
  undeclaredCapabilityProvider: 'UNDECLARED_CAPABILITY_PROVIDER',
  /** 提供方版本不满足调用方声明的版本范围。 */
  versionMismatch: 'VERSION_MISMATCH',
  /** 服务面还没启动，或已经启动失败。 */
  kernelNotStarted: 'KERNEL_NOT_STARTED',
  /** 之前已经启动失败过，同一个内核不会再试。 */
  kernelStartFailed: 'KERNEL_START_FAILED',
  /** 本内核没有接 ModStore，`mods.*` 无从谈起。 */
  modsUnavailable: 'MODS_UNAVAILABLE',
  /** 从目录安装 mod 失败：目录不在、清单不合法、入口导不出模块定义。 */
  modInstallFailed: 'MOD_INSTALL_FAILED',
  /** 启停一个不在索引里的 mod pack。 */
  modNotFound: 'MOD_NOT_FOUND',
})

/**
 * 能力调用失败的码：进程内抛出的错误与 wire 失败信封共用这一张表。
 *
 * 两边同码才保证「进程内怎么判、经 RPC 也怎么判」，外面不必按报错文字猜。
 */
export const KernelCallErrorCodes = Object.freeze({
  /** 请求本身不合协议：字段缺失、形状不对。 */
  invalidRequest: 'INVALID_REQUEST',
  /** 服务面还没启动。 */
  kernelNotStarted: 'KERNEL_NOT_STARTED',
  /** 这个内核上没有这件能力。 */
  capabilityNotFound: 'CAPABILITY_NOT_FOUND',
  /** 能力在册但当前没有活动的提供方。 */
  capabilityNotAvailable: 'CAPABILITY_NOT_AVAILABLE',
  /** 能力的服务没有实现可调用约定。 */
  capabilityNotCallable: 'CAPABILITY_NOT_CALLABLE',
  /** 调用落在会话没有绑定的能力上。 */
  capabilityNotGranted: 'CAPABILITY_NOT_GRANTED',
  /** 宿主的绑定策略拒绝了这次会话绑定。 */
  capabilityBindDenied: 'CAPABILITY_BIND_DENIED',
  /** 绑定判定本身出错，没能给出结论。 */
  capabilityBindFailed: 'CAPABILITY_BIND_FAILED',
  /** 能力上没有这个操作。 */
  operationNotFound: 'OPERATION_NOT_FOUND',
  /** provider 描述操作元数据时抛错。 */
  operationMetadataFailed: 'OPERATION_METADATA_FAILED',
  /** 宿主的授权判定明确拒绝。 */
  permissionDenied: 'PERMISSION_DENIED',
  /** 授权判定本身出错，没能给出结论。 */
  permissionCheckFailed: 'PERMISSION_CHECK_FAILED',
  /** 调用被调用方中止。 */
  callAborted: 'CALL_ABORTED',
  /** provider 代码执行时抛错。 */
  capabilityCallFailed: 'CAPABILITY_CALL_FAILED',
})

/** 瘦客户端、启动器与本机 RPC 这条线上的失败码。 */
export const KernelClientErrorCodes = Object.freeze({
  /** 传输已关闭。 */
  transportClosed: 'TRANSPORT_CLOSED',
  /** 往 socket 写失败。 */
  transportWriteFailed: 'TRANSPORT_WRITE_FAILED',
  /** 连不上守护进程的端点。 */
  transportConnectFailed: 'TRANSPORT_CONNECT_FAILED',
  /** 连接中途断开，在途请求全部落空。 */
  transportDisconnected: 'TRANSPORT_DISCONNECTED',
  /** 收到的响应帧不合协议。 */
  invalidResponse: 'INVALID_RESPONSE',
  /** 本机已有一个守护进程在跑。 */
  daemonAlreadyRunning: 'DAEMON_ALREADY_RUNNING',
  /** 拿不到单实例锁。 */
  daemonLockFailed: 'DAEMON_LOCK_FAILED',
  /** descriptor 文件不合法。 */
  daemonDescriptorInvalid: 'DAEMON_DESCRIPTOR_INVALID',
  /** 本机没有守护进程在跑。 */
  daemonNotRunning: 'DAEMON_NOT_RUNNING',
  /** 客户端与守护进程的协议版本不同；协议只接受完全相同的版本。 */
  protocolVersionMismatch: 'PROTOCOL_VERSION_MISMATCH',
  /** 启动守护进程失败。 */
  kernelStartFailed: 'KERNEL_START_FAILED',
  /** 等守护进程发布端点超时。 */
  kernelStartTimeout: 'KERNEL_START_TIMEOUT',
  /** 守护进程起来了但健康检查不过。 */
  kernelUnhealthy: 'KERNEL_UNHEALTHY',
  /** 启动器已回收。 */
  launcherDisposed: 'LAUNCHER_DISPOSED',
  /** RPC 帧不合协议。 */
  invalidRpcFrame: 'INVALID_RPC_FRAME',
  /** RPC 方法名不在方法表里。 */
  unknownRpcMethod: 'UNKNOWN_RPC_METHOD',
  /** RPC 参数不合法。 */
  invalidParams: 'INVALID_PARAMS',
  /** RPC 认证令牌不对。 */
  unauthorized: 'UNAUTHORIZED',
  /** 单帧超过上限。 */
  frameTooLarge: 'FRAME_TOO_LARGE',
  /** 内核没有接 ModStore。 */
  modsUnavailable: 'MODS_UNAVAILABLE',
  /** 服务端没说原因的失败。 */
  internalError: 'INTERNAL_ERROR',
})

/** 共享 Runtime 安装器这条线上的失败码。 */
export const KernelUpdaterErrorCodes = Object.freeze({
  /** 更新清单里没有这个平台架构的制品。 */
  artifactNotFound: 'ARTIFACT_NOT_FOUND',
  /** 下载到的字节数与清单声明的不一致。 */
  artifactSizeMismatch: 'ARTIFACT_SIZE_MISMATCH',
  /** SHA-256 与清单声明的不一致。 */
  digestMismatch: 'DIGEST_MISMATCH',
  /** 下载失败。 */
  downloadFailed: 'DOWNLOAD_FAILED',
  /** 新版本装上了但健康检查不过，指针已回滚。 */
  healthCheckFailed: 'HEALTH_CHECK_FAILED',
  /** 落位安装失败。 */
  installFailed: 'INSTALL_FAILED',
  /** 更新清单不合法。 */
  invalidManifest: 'INVALID_MANIFEST',
  /** 激活指针文件不合法。 */
  invalidPointer: 'INVALID_POINTER',
  /** 版本号不是合法的 x.y.z。 */
  invalidVersion: 'INVALID_VERSION',
  /** 版本范围写法不合法。 */
  invalidVersionRange: 'INVALID_VERSION_RANGE',
  /** 取不到更新清单。 */
  manifestUnreachable: 'MANIFEST_UNREACHABLE',
  /** 没有可回滚的旧版本。 */
  noRollbackTarget: 'NO_ROLLBACK_TARGET',
  /** 制品签名校验不通过。 */
  signatureRejected: 'SIGNATURE_REJECTED',
  /** 清单不支持当前平台架构。 */
  unsupportedTarget: 'UNSUPPORTED_TARGET',
  /** 别的进程正拿着更新锁。 */
  updateLockHeld: 'UPDATE_LOCK_HELD',
  /** 要激活的版本本机没装。 */
  versionNotInstalled: 'VERSION_NOT_INSTALLED',
  /** 清单里没有满足范围的版本。 */
  versionUnavailable: 'VERSION_UNAVAILABLE',
})

/** 远程节点两端共用的失败码：Client 侧 10 个 + wire 帧上的 10 个。 */
export const RemoteNodeErrorCodes = Object.freeze({
  /** 对端重启，在途调用的结果永远不会再来。 */
  nodeRestarted: 'NODE_RESTARTED',
  /** 两端协议版本不同。 */
  protocolMismatch: 'REMOTE_NODE_PROTOCOL_MISMATCH',
  /** 签名认证没过。 */
  unauthorized: 'REMOTE_NODE_UNAUTHORIZED',
  /** 需要人工配对码才能继续（没配过对，或本机凭据丢了）。 */
  pairingRequired: 'REMOTE_NODE_PAIRING_REQUIRED',
  /** 被同一 Client 的新连接顶替。 */
  superseded: 'REMOTE_NODE_SUPERSEDED',
  /** Client 已回收。 */
  disposed: 'REMOTE_NODE_DISPOSED',
  /** 本机凭据读不出来（钥匙串锁着、文件权限不对），连都还没连上。 */
  credentialsUnavailable: 'REMOTE_NODE_CREDENTIALS_UNAVAILABLE',
  /** 调用超过 Client 侧截止时间。 */
  callTimeout: 'REMOTE_NODE_CALL_TIMEOUT',
  /** 调用在 Node 侧执行失败。 */
  callFailed: 'REMOTE_NODE_CALL_FAILED',
  /** Node 侧派发后被自己的策略拒绝——是策略事实，不是链路故障。 */
  callDenied: 'REMOTE_NODE_CALL_DENIED',
  /** 收到的帧不合协议。 */
  frameInvalid: 'FRAME_INVALID',
  /** 配对失败。 */
  pairingFailed: 'PAIRING_FAILED',
  /** 调用超过约定的截止时长。 */
  deadlineExceeded: 'DEADLINE_EXCEEDED',
  /** 调用被取消。 */
  callAborted: 'CALL_ABORTED',
  /** 被 Node 侧策略拒绝。 */
  denied: 'DENIED',
  /** 调用带着过期的清单修订号。 */
  manifestStale: 'MANIFEST_STALE',
  /** Node 侧已停机。 */
  nodeStopped: 'NODE_STOPPED',
})

/** 远程节点 WebSocket 的关闭码（4000 段是应用自定义段）。 */
export const RemoteNodeCloseCodes = Object.freeze({
  /** 协议版本不同。 */
  protocolMismatch: 4001,
  /** 认证没过。 */
  unauthorized: 4002,
  /** 被新连接顶替。 */
  superseded: 4003,
  /** Node 侧主动停机。 */
  nodeStopped: 4004,
})

/** 远程节点的连线地址与进度事件名。 */
export const RemoteNodeSocketPath = '/v1/remote-node/ws'

/** 远程调用进度事件的类型名；两端与宿主都按它认。 */
export const RemoteNodeProgressEventType = 'remote-node.progress'

/**
 * 远程节点两端共同遵守的协议数字。
 *
 * 这些不是可调参数：一端改了另一端就对不上，所以它们是对外承诺而不是 tuning。
 */
export const RemoteNodeLimits = Object.freeze({
  /** 单帧字节上限 32 MiB。 */
  maxFrameBytes: 33_554_432,
  /** 配对码有效期 5 分钟。 */
  pairingWindowMs: 300_000,
  /** 配对连续失败 5 次就锁定。 */
  pairingFailureLimit: 5,
  /** 配对锁定 30 秒。 */
  pairingLockoutMs: 30_000,
  /** 心跳间隔 15 秒。 */
  heartbeatIntervalMs: 15_000,
  /** 空闲 60 秒判死。 */
  idleTimeoutMs: 60_000,
  /** 缺省监听端口区间起点。 */
  defaultPortStart: 43_180,
  /** 缺省监听端口区间终点。 */
  defaultPortEnd: 43_190,
})

/** 本机 RPC 的协议上限：客户端与服务端读同一份。 */
export const KernelRpcLimits = Object.freeze({
  /** 单帧字节上限 4 MiB。 */
  maxFrameBytes: 4_194_304,
})

/**
 * 内核读的环境变量表。
 *
 * `input` 的四个只给守护进程可执行文件；`VELAROS_KERNEL_RUNTIME_DIR` 与
 * `VELAROS_KERNEL_HOME` 任何宿主都可以设。家目录一律走 `os.homedir()`，不直接读 `HOME`。
 */
export const KernelEnvironmentVariables = Object.freeze({
  /** 守护进程运行目录（socket、descriptor、锁文件）。 */
  runtimeDirectory: 'VELAROS_KERNEL_RUNTIME_DIR',
  /** 共享 Runtime 的安装根。 */
  installRoot: 'VELAROS_KERNEL_HOME',
  /** 可执行文件自报的内核版本。 */
  kernelVersion: 'VELAROS_KERNEL_VERSION',
  /** 用户 mod 目录。 */
  userMods: 'VELAROS_KERNEL_USER_MODS',
  /** 启动时从这个目录安装一个 mod pack。 */
  installPack: 'VELAROS_KERNEL_INSTALL_PACK',
  /** 以 JSON 数组交进来的系统 pack 清单。 */
  systemPacks: 'VELAROS_KERNEL_SYSTEM_PACKS',
})

/** 模块宿主自己抛出的失败码。 */
export type KernelErrorCode = (typeof KernelErrorCodes)[keyof typeof KernelErrorCodes]

/** 能力调用失败码，进程内与 wire 共用。 */
export type KernelCallErrorCode = (typeof KernelCallErrorCodes)[keyof typeof KernelCallErrorCodes]

/** 瘦客户端、启动器与本机 RPC 的失败码。 */
export type KernelClientErrorCode = (typeof KernelClientErrorCodes)[keyof typeof KernelClientErrorCodes]

/** 共享 Runtime 安装器的失败码。 */
export type KernelUpdaterErrorCode = (typeof KernelUpdaterErrorCodes)[keyof typeof KernelUpdaterErrorCodes]

/** 远程节点两端的失败码。 */
export type RemoteNodeErrorCode = (typeof RemoteNodeErrorCodes)[keyof typeof RemoteNodeErrorCodes]

/** 远程节点 WebSocket 关闭码。 */
export type RemoteNodeCloseCode = (typeof RemoteNodeCloseCodes)[keyof typeof RemoteNodeCloseCodes]

/** 合法的模块隔离形态。 */
export type KernelModuleIsolation = (typeof KernelModuleIsolations)[keyof typeof KernelModuleIsolations]

/**
 * 内核宿主对 mod 清单自报的版本，等于 {@link KernelVersionAxes}.kernel。
 *
 * 保留这个名字是为了让八个能力包与三个产品这一轮零改动；入口收口那一轮统一改成读版本轴表。
 */
export const KernelVersion = '0.3.0' as const

/**
 * 模块清单 ABI 版本，等于 {@link KernelVersionAxes}.moduleApi。
 *
 * 能力包写 `apiVersion: KernelModuleApiVersion`；门禁禁止在清单里直接写数字 1。
 * 同上，入口收口那一轮改成读版本轴表。
 */
export const KernelModuleApiVersion = 1
