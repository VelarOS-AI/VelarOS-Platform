// 域：共享 Runtime 更新器的数据形状（发布清单、制品、安装记录、激活指针、更新锁与四个注入口）。
//
// 这些类型手写在这里，zod schema 留在 `utils/updater/`，并用 `satisfies z.ZodType<…>` 反向守：
// 类型是人读的单源，schema 是运行期校验，两边对不上编译期就报错（方案 §3.5 第 1 条）。
// 四个注入口（`KernelFetch`、`KernelHealthCheck`、`KernelArtifactExtractor`、
// `KernelArtifactSignatureVerifier`）已经搬进 `contract/requires.ts`，这里只剩它们的配套数据。
import type {
  KernelArtifactExtractor,
  KernelArtifactSignatureVerifier,
  KernelFetch,
  KernelHealthCheck,
} from '../contract/requires.js'

import type { SemanticVersion } from './runtime.js'

/** 制品支持的操作系统。 */
export type KernelPlatform = 'darwin' | 'linux' | 'win32'

/** 制品支持的处理器架构。 */
export type KernelArchitecture = 'arm64' | 'x64'

/** 一份制品面向的「操作系统-架构」组合，发布清单按它分发。 */
export type KernelArtifactTarget =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-arm64'
  | 'win32-x64'

/** 制品的打包格式；`raw` 是单个不透明文件，其余要靠注入的解包器展开。 */
export type KernelArtifactFormat = 'raw' | 'tar.gz' | 'tar.zst' | 'zip'

/** 更新器面上的版本号形状，与包内唯一的语义化版本口径同构。 */
export type KernelSemanticVersion = SemanticVersion

/** 发布清单里的一份制品：去哪儿取、多大、摘要是什么、怎么解包。 */
export interface KernelArtifact {
  /** 制品的下载地址；`http(s)`、`file:` 与绝对路径都认。 */
  readonly url: string
  /** 制品的字节数；下载超过这个数就当清单与实际对不上。 */
  readonly size: number
  /** 制品的 SHA-256 摘要，小写十六进制；落位前必须逐字节对上。 */
  readonly sha256: string
  /** 制品的打包格式；缺席按 `raw` 算。 */
  readonly format: KernelArtifactFormat
  /** 发布方给的签名串；没有签名就缺席。 */
  readonly signature?: string
}

/** 发布清单里的一个版本：版本号、发布说明与它在各目标上的制品。 */
export interface KernelManifestVersion {
  /** 这个条目的语义化版本号。 */
  readonly version: string
  /** 发布时刻（发布方自己的格式）；没写就缺席。 */
  readonly releasedAt?: string
  /** 发布说明；没写就缺席。 */
  readonly notes?: string
  /** 这个版本是否已撤回；撤回的版本默认不参与挑选。 */
  readonly yanked: boolean
  /** 按目标索引的制品表；某个目标没发布就缺席。 */
  readonly artifacts: { [T in KernelArtifactTarget]?: KernelArtifact }
}

/** 一份内核更新清单：发布通道与它公布的全部版本。 */
export interface KernelUpdateManifest {
  /** 清单结构的版本号，目前只接受 1。 */
  readonly schemaVersion: 1
  /** 发布通道名；缺席按 `stable` 算。 */
  readonly channel: string
  /** 公布的版本列表，至少一条。 */
  readonly versions: KernelManifestVersion[]
}

/** 一次挑选的结论：哪个版本、哪个目标、取哪份制品。 */
export interface KernelArtifactSelection {
  /** 挑中的版本号。 */
  readonly version: string
  /** 挑中的制品目标。 */
  readonly target: KernelArtifactTarget
  /** 挑中的那份制品。 */
  readonly artifact: KernelArtifact
}

/** 在清单里挑版本的条件。 */
export interface KernelManifestQuery {
  /** 版本范围；缺席表示不限。 */
  readonly range?: string
  /** 只要在这个目标上发布了制品的版本；缺席表示不限。 */
  readonly target?: KernelArtifactTarget
  /** 是否把撤回的版本也算进来；缺省不算。 */
  readonly includeYanked?: boolean
}

/** 取一份更新清单时的可选项。 */
export interface KernelManifestLoadOptions {
  /** 自带的取数实现；缺席时走 Node 的默认实现。 */
  readonly fetch?: KernelFetch
  /** 取消信号；中止时这次取数以失败结束。 */
  readonly signal?: AbortSignal
}

/** 一次取数请求：取哪个地址、能不能中途取消。 */
export interface KernelFetchRequest {
  /** 要取的地址；`http(s)` 走网络，其余按本机路径读。 */
  readonly url: string
  /** 取消信号；缺席表示不可取消。 */
  readonly signal?: AbortSignal
}

/** 一次取数的回应：HTTP 状态码与按块产出的字节流。 */
export interface KernelFetchResponse {
  /** HTTP 语义的状态码；本机读文件时用 200 / 404 表示读到与没读到。 */
  readonly status: number
  /** 回应体，按块异步产出，从不整份留在内存里。 */
  readonly body: AsyncIterable<Uint8Array>
}


/** 下载一份制品时的入参。 */
export interface KernelArtifactDownloadOptions {
  /** 要下载的制品（地址、大小与摘要都从这里取）。 */
  readonly artifact: KernelArtifact
  /** 落盘路径；失败时这个文件会被删掉，不留半截。 */
  readonly destination: string
  /** 自带的取数实现；缺席时走 Node 的默认实现。 */
  readonly fetch?: KernelFetch
  /** 取消信号；中止时这次下载以失败结束。 */
  readonly signal?: AbortSignal
}

/** 一次下载的结论：落在哪、多少字节、实际摘要是什么。 */
export interface KernelArtifactDownloadResult {
  /** 制品实际落盘的路径。 */
  readonly path: string
  /** 实际写下去的字节数，与清单声明的一致。 */
  readonly size: number
  /** 边下边算出来的 SHA-256，与清单声明的一致。 */
  readonly sha256: string
}

/**
 * 更新器拥有的一组绝对路径。
 *
 * 全部从同一个根派生，产品由此可以装一份私有内核而不和共享的那份撞在一起。
 */
export interface KernelInstallLayout {
  /** 安装根目录。 */
  readonly root: string
  /** 各版本安装目录的父目录。 */
  readonly versionsDirectory: string
  /** 激活指针 `current.json` 的路径。 */
  readonly pointerPath: string
  /** 守护进程运行目录（socket、descriptor 落在这里）。 */
  readonly runtimeDirectory: string
  /** 内核数据目录。 */
  readonly dataDirectory: string
  /** 指针备份目录，每次激活留一份旧指针。 */
  readonly backupsDirectory: string
  /** 安装暂存目录，装好后整目录改名到 `versions/` 下。 */
  readonly stagingDirectory: string
  /** 跨进程更新锁的文件路径。 */
  readonly lockPath: string
}

/**
 * 写在暂存目录里、随目录一起改名就位的安装记录。
 *
 * 它在场就等于「改名完成、这份安装是整的」，所以是判断安装完整与否的唯一凭据。
 */
export interface KernelInstallRecord {
  /** 记录结构的版本号，目前只接受 1。 */
  readonly schemaVersion: 1
  /** 装的是哪个版本。 */
  readonly version: string
  /** 装的是哪个目标的制品。 */
  readonly target: KernelArtifactTarget
  /** 装的制品是什么格式。 */
  readonly format: KernelArtifactFormat
  /** 装下去的制品的 SHA-256。 */
  readonly sha256: string
  /** 装下去的制品的字节数。 */
  readonly size: number
  /** 安装完成的时刻（毫秒时间戳）。 */
  readonly installedAt: number
}

/** 本机已安装的一个版本的现状。 */
export interface KernelInstalledVersion {
  /** 版本号。 */
  readonly version: string
  /** 这个版本的安装目录。 */
  readonly path: string
  /** 它是不是当前激活的那个版本。 */
  readonly active: boolean
  /** 安装是不是整的（安装记录在不在）。 */
  readonly complete: boolean
  /** 安装记录；不整的安装就缺席。 */
  readonly record?: KernelInstallRecord
}

/**
 * `current.json` 的内容：当前激活的版本与回滚目标。
 *
 * `previousVersion` 记着回滚目标，只要它还记在这里，那个版本就不会被清理掉。
 */
export interface KernelActivePointer {
  /** 指针结构的版本号，目前只接受 1。 */
  readonly schemaVersion: 1
  /** 当前激活的版本号。 */
  readonly version: string
  /** 回滚目标的版本号；没有可回滚的就是 null。 */
  readonly previousVersion: Nullable<string>
  /** 这次切换的时刻（毫秒时间戳）。 */
  readonly updatedAt: number
  /** 切换者的标识；不知道是谁切的就是 null。 */
  readonly updatedBy: Nullable<string>
}

/** 写进锁文件的属主信息，别的进程据此判断锁是活的还是崩溃残留。 */
export interface KernelUpdateLockRecord {
  /** 持锁者的标识，缺省是一个随机 id。 */
  readonly holderId: string
  /** 持锁进程的 pid，用来判断属主还在不在。 */
  readonly pid: number
  /** 拿到锁的时刻（毫秒时间戳）。 */
  readonly acquiredAt: number
}

/** 一把更新锁的构造入参：锁在哪、属主是谁、读不出属主时怎么重试。 */
export interface KernelUpdateLockOptions {
  /** 锁文件路径；它的父目录不在时会被建出来。 */
  readonly lockPath: string
  /** 持锁者标识；缺席时随机生成一个。 */
  readonly holderId?: string
  /** 判断某个 pid 还在不在；缺席时用 `kill(pid, 0)` 探。 */
  readonly isProcessAlive?: (pid: number) => boolean
  /** 取当前时刻；缺席时用 `Date.now`。 */
  readonly now?: () => number
  /** 读不出锁属主时重读几次（对方可能刚 open('wx') 还没写进 pid）；缺席时用可调参数表里的次数。 */
  readonly ownerReadRetries?: number
  /** 两次重读之间等多少毫秒；缺席时用可调参数表里的间隔。 */
  readonly ownerReadRetryMs?: number
  /** 等待用的 sleep；缺席时用内核自己的定时器域。 */
  readonly sleep?: (ms: number) => Promise<void>
}

/** 一个已存在的锁文件归谁：被活着的进程持着、属主已经不在可以回收、还是重读多次都读不出。 */
export type KernelUpdateLockOwner =
  /** 属主进程还活着，锁不能抢。 */
  | { readonly status: 'held'; readonly pid: number }
  /** 属主进程已经不在，锁可以回收。 */
  | { readonly status: 'stale' }
  /** 重读多次仍读不出属主（文件为空或内容损坏）。 */
  | { readonly status: 'unreadable' }

/** 健康检查看到的现场：刚激活的是哪个版本、装在哪、上一个版本是谁。 */
export interface KernelHealthCheckContext {
  /** 刚激活的版本号。 */
  readonly version: string
  /** 这个版本的安装目录。 */
  readonly path: string
  /** 上一个激活的版本号；没有就是 null。 */
  readonly previousVersion: Nullable<string>
}


/** 激活一个版本时的可选项。 */
export interface KernelActivationOptions {
  /** 切换后跑一遍的健康检查；没过就回滚指针并报失败。缺席表示切了就算数。 */
  readonly healthCheck?: KernelHealthCheck
}

/** 确保某个版本装好时的可选项。 */
export interface KernelEnsureInstalledOptions {
  /** 现成的发布清单；缺席时按 `manifestSource` 去取。 */
  readonly manifest?: KernelUpdateManifest
  /** 去哪儿取发布清单；缺席时用更新器构造时配的来源。 */
  readonly manifestSource?: string
  /** 已经装过也重装一遍；缺省是装过就复用。 */
  readonly force?: boolean
  /** 取消信号；中止时这次安装以失败结束。 */
  readonly signal?: AbortSignal
}

/** 「保证有一个满足范围的内核在跑」这件事的入参。 */
export interface KernelCompatibilityRequirement {
  /** 要满足的版本范围。 */
  readonly range: string
  /** 去哪儿取发布清单；缺席时用更新器构造时配的来源。 */
  readonly manifestSource?: string
  /** 切换后跑一遍的健康检查；没过就回滚。 */
  readonly healthCheck?: KernelHealthCheck
  /** 本机没有满足的版本时允不允许联网装一个；缺省允许。 */
  readonly allowInstall?: boolean
  /** 取消信号；中止时这次调用以失败结束。 */
  readonly signal?: AbortSignal
}

/** 一次安装的结论：装的是哪个版本、在哪、这次是真装了还是复用了现成的。 */
export interface KernelInstallOutcome {
  /** 装好的版本号。 */
  readonly version: string
  /** 这个版本的安装目录。 */
  readonly path: string
  /** 这次调用有没有真的落盘（false 表示复用了已有的完整安装）。 */
  readonly installed: boolean
  /** 这个版本的安装记录。 */
  readonly record: KernelInstallRecord
}

/** 一次兼容性保障的结论：最终用的哪个版本、这次装没装、切没切。 */
export interface KernelCompatibilityOutcome {
  /** 最终满足范围的那个版本号。 */
  readonly version: string
  /** 这次调用有没有装新版本。 */
  readonly installed: boolean
  /** 这次调用有没有切换激活指针。 */
  readonly activated: boolean
  /** 调用结束时的激活指针。 */
  readonly pointer: KernelActivePointer
}

/** 清理旧安装时的可选项。 */
export interface KernelPruneOptions {
  /** 保留几个版本；缺席时用更新器构造时配的条数。激活版本与回滚目标永远保留。 */
  readonly retain?: number
}

/** 一台更新器的构造入参：装在哪、取哪个目标的制品、哪些扩展点由宿主提供。 */
export interface KernelUpdaterOptions {
  /** 安装根目录；缺席时按平台默认位置算。与 `layout` 二选一。 */
  readonly root?: string
  /** 现成的路径布局；给了就不再从 `root` 派生。 */
  readonly layout?: KernelInstallLayout
  /** 去哪儿取发布清单；缺席时每次调用都得自己带来源。 */
  readonly manifestSource?: string
  /** 按哪个操作系统算制品目标；缺席时用本进程的。 */
  readonly platform?: string
  /** 按哪个架构算制品目标；缺席时用本进程的。 */
  readonly architecture?: string
  /** 直接指定制品目标；给了就不再从平台与架构推。 */
  readonly target?: KernelArtifactTarget
  /** 注入的取数实现；缺席时走 Node 的默认实现。 */
  readonly fetch?: KernelFetch
  /** 注入的解包器；缺席时按不透明单文件落位。 */
  readonly extractor?: KernelArtifactExtractor
  /** 注入的签名校验器；缺席时一律报「没校验」但不拦。 */
  readonly signatureVerifier?: KernelArtifactSignatureVerifier
  /** 是否要求签名校验通过才肯装；缺省不要求。 */
  readonly requireSignature?: boolean
  /** 本机保留几个已安装版本；缺席时用可调参数表里的条数。 */
  readonly retainedVersions?: number
  /** 写进更新锁的持锁者标识；缺席时随机生成一个。 */
  readonly holderId?: string
  /** 取当前时刻；缺席时用 `Date.now`。 */
  readonly now?: () => number
  /** 判断某个 pid 还在不在；缺席时用 `kill(pid, 0)` 探。 */
  readonly isProcessAlive?: (pid: number) => boolean
}

/** 解包器看到的现场：装的是哪个版本、制品在哪、要展开到哪个目录。 */
export interface KernelArtifactExtractionContext {
  /** 正在安装的版本号。 */
  readonly version: string
  /** 正在安装的制品目标。 */
  readonly target: KernelArtifactTarget
  /** 清单里的那份制品（格式、地址都在里面）。 */
  readonly artifact: KernelArtifact
  /** 已经校验过的制品在本机的落点。 */
  readonly payloadPath: string
  /** 只许往这个目录里写；它随后被整体改名成 `versions/<version>/`。 */
  readonly destinationDirectory: string
}


/** 签名校验器看到的现场：装的是哪个版本、制品在哪、实际摘要是什么。 */
export interface KernelArtifactSignatureContext {
  /** 正在安装的版本号。 */
  readonly version: string
  /** 正在安装的制品目标。 */
  readonly target: KernelArtifactTarget
  /** 清单里的那份制品（`signature` 字段在里面）。 */
  readonly artifact: KernelArtifact
  /** 已经下载好的制品在本机的落点。 */
  readonly payloadPath: string
  /** 边下边算出来的 SHA-256，已经和清单对上了。 */
  readonly sha256: string
}

/** 一次签名校验的结论：过没过、用的什么方法、没过是为什么。 */
export interface KernelArtifactSignatureResult {
  /** 签名有没有校验通过。 */
  readonly verified: boolean
  /** 用的什么校验方法；没装校验器时是 `none`。 */
  readonly method: string
  /** 没通过的原因；通过时可以缺席。 */
  readonly reason?: string
}

