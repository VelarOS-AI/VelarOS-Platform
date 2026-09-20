/**
 * 包内可调参数：超时、轮询、重试、保留条数、并发与缓冲。
 *
 * 只放数字，每项一句说明、每项有人用。对外承诺的上限（协议帧上限、端口区间、配对窗口）
 * 不在这里，在 `contract/constants.ts`；类自己固定用的写成类内 `private static readonly`。
 */
export const KernelTuning = Object.freeze({
  /** 模块发现缺省每页条数。 */
  modulePageSize: 20,
  /** 启动器：等守护进程发布端点的上限，毫秒。 */
  launcherStartTimeoutMs: 30_000,
  /** 启动器：轮询 descriptor 的间隔，毫秒。 */
  launcherPollIntervalMs: 100,
  /** 启动器：停机时先等这么久再升级信号，毫秒。 */
  launcherStopGraceMs: 5_000,
  /** 启动器：宽限过后到 SIGKILL 之间再等这么久，毫秒。 */
  launcherStopKillGraceMs: 2_000,
  /** 锁文件：读不出属主时重读几次（对方可能刚 open 还没写 pid）。 */
  lockOwnerReadRetries: 3,
  /** 锁文件：两次重读之间等多久，毫秒。 */
  lockOwnerReadRetryMs: 20,
  /** 更新器：本机保留几个已安装版本，多的按时间清掉。 */
  updaterRetainedVersions: 3,
  /** 更新器：一份更新清单最多读这么多字节，超了就当取不到，免得一个坏来源把内存撑爆。 */
  updaterMaxManifestBytes: 8_388_608,
  /** 远程 Client：给服务端截止时间加的宽限，毫秒。 */
  remoteClientDeadlineGraceMs: 5_000,
  /** 远程 Client：一次调用的缺省截止时长，毫秒。 */
  remoteClientDefaultDeadlineMs: 120_000,
  /** 远程 Client：重连退避的首跳，毫秒。 */
  remoteClientReconnectInitialDelayMs: 500,
  /** 远程 Client：重连退避的上限，毫秒。 */
  remoteClientReconnectMaxDelayMs: 30_000,
  /** 远程 Client：重连退避的抖动比例。 */
  remoteClientReconnectJitterRatio: 0.25,
  /** 远程 Client：重连退避的指数上限（再大也不翻倍了）。 */
  remoteClientReconnectMaxExponent: 6,
  /** 远程 Node：同时执行的能力调用上限。 */
  remoteNodeMaxConcurrentInvocations: 4,
  /** 远程 Node：终态回放缓存容量，够覆盖一次断线重连窗口。 */
  remoteNodeCompletedCallCapacity: 256,
})
