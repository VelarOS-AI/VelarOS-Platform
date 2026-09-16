/**
 * 记忆树 v2 存储物理层的数据形状：五物理根、代际指针、密钥环、密文信封、派生索引代。
 * 树 v2 是包内子系统，这些类型不出包。
 */

/** 崩溃注入钩子：每个写入步骤执行前汇报一次，探针在指定步骤抛错即模拟"该步之前断电"。 */
export interface StorageStepHooksV2 {
  /** 写入步骤开始前回调；step 形如 `<label>:write-temp`。抛错即模拟崩溃。 */
  beforeStep?(step: string): void
}

/**
 * 存储物理层专用错误码。与 `utils/tree-v2/storage/error-codes.ts` 的码表一一对应；
 * 类型文件不许有值，所以这里直接列字面量。
 */
export type MemoryStorageErrorCodeV2 =
  | 'MEMORY_STORAGE_CORRUPTION'
  | 'MEMORY_WRAPPING_ROOT_MISMATCH'
  | 'MEMORY_DEK_DESTROYED'
  | 'MEMORY_BLOB_CORRUPTED'
  | 'MEMORY_COMMITMENT_MISMATCH'

/** 代际目录或文件的一条枚举结果（`generation-<n>` + 约定后缀）。 */
export interface GenerationEntryV2 {
  /** 代号，正整数。 */
  readonly generation: number
  /** 条目名（不含目录）。 */
  readonly name: string
  /** 条目的绝对路径。 */
  readonly path: string
}

/** 提交 CURRENT 指针时的可选项。 */
export interface CommitCurrentGenerationOptionsV2 {
  /** 崩溃注入步骤名前缀；不给就用 `current`。 */
  readonly label?: string
  /** 崩溃注入钩子。 */
  readonly hooks?: StorageStepHooksV2
}

/** 枚举代际实体时的筛选条件。 */
export interface ListGenerationEntriesOptionsV2 {
  /** 代际实体名的后缀（目录形态传空串）。 */
  readonly suffix: string
  /** 代际实体是文件还是目录。 */
  readonly kind: 'file' | 'directory'
}

/** 原子写文件的可选项。 */
export interface WriteFileAtomicOptionsV2 {
  /** 崩溃注入步骤名前缀。 */
  readonly label: string
  /** 崩溃注入钩子。 */
  readonly hooks?: StorageStepHooksV2
}

/**
 * OS 安全存储中的 wrapping root 端口。
 * memory 包永远不 import Electron、Keychain 或 DPAPI：宿主给这一个 root，keyring 只持
 * `wrappingRootId` 和被包装的字节。
 */
export interface MemoryWrappingRootV2 {
  /** 稳定引用 id，格式冻结为 `wr-<小写 hex>`；不是密钥本身。 */
  readonly id: string
  /** 把 32 字节明文密钥包装成信封字节；失败抛错。 */
  wrapKey(key: Buffer): Buffer
  /** 把信封字节解回 32 字节明文密钥；解不开抛 MEMORY_STORAGE_CORRUPTION。 */
  unwrapKey(wrapped: Buffer): Buffer
}

/** 五物理根的绝对路径集合（纯解析结果，不代表目录已经存在）。 */
export interface MemoryPhysicalRootsV2 {
  /** 宿主注入的数据根（必须是绝对路径）。 */
  readonly dataRoot: string
  /** `<dataRoot>/memory`。 */
  readonly memoryRoot: string
  /** 权威库宿主目录。 */
  readonly authorityDir: string
  /** 权威库文件路径（S2 建库；本层自检只要求"存在则必须是文件"）。 */
  readonly authorityDatabasePath: string
  /** 密文正文目录（两级 hex 分片）。 */
  readonly blobsDir: string
  /** 密钥环目录（永不复制、永不入备份）。 */
  readonly keyringDir: string
  /** 派生索引代际目录。 */
  readonly indexDir: string
  /** 应用管理备份目录。 */
  readonly backupDir: string
}

/** 打开五物理根的一次读数。 */
export interface MemoryPhysicalRootsOpenReportV2 {
  /** 本次 open 新建的目录（绝对路径，按创建顺序）。 */
  readonly createdDirectories: readonly string[]
  /** 非致命布局异常（备份快照命名不合规、快照含未知条目等）。 */
  readonly warnings: readonly string[]
}

/** 派生索引代的密文信封（磁盘上只出现这一种形态）。 */
export interface MemoryIndexGenerationEnvelopeV2 {
  /** 格式身份，固定 `velaros.memory.index-generation.v2`。 */
  readonly format: 'velaros.memory.index-generation.v2'
  /** 这一代的代号。 */
  readonly generation: number
  /** 信封算法，固定 `A256GCM`。 */
  readonly algorithm: 'A256GCM'
  /** base64 的 12 字节 IV。 */
  readonly iv: string
  /** base64 的 16 字节 GCM tag。 */
  readonly tag: string
  /** base64 的密文。 */
  readonly ciphertext: string
}

/** 封存一代派生索引后的读数。 */
export interface MemoryIndexGenerationSealReportV2 {
  /** 新提交的代号。 */
  readonly generation: number
  /** 密文字节数。 */
  readonly encryptedByteLength: number
  /** 被它取代的上一代；本来就没有生效代时为 null。 */
  readonly replacedGeneration: Nullable<number>
}

/** 解封出来的当前派生索引代；调用方负责尽快清零 plaintextArtifact。 */
export interface MemoryIndexGenerationSnapshotV2 {
  /** 生效代号。 */
  readonly generation: number
  /** 解封后的明文产物字节。 */
  readonly plaintextArtifact: Buffer
}

/**
 * 派生索引代封存要用到的密钥环能力面。
 * utils 不许引 impl，索引代的封存与解封在 utils 里，所以这里把它要的三个动作单列成端口，
 * 由 `MemoryKeyringStoreV2` 结构上满足。
 */
export interface MemoryIndexGenerationKeyringV2 {
  /** 取（没有就造）这一代的索引密钥；返回的 Buffer 由调用方清零。 */
  getOrCreateIndexGenerationKey(generation: number): Buffer
  /** 取这一代的索引密钥；已销毁抛 MEMORY_DEK_DESTROYED。 */
  getIndexGenerationKey(generation: number): Buffer
  /** 销毁这一代的索引密钥；本来就没有返回 false。 */
  destroyIndexGenerationKey(generation: number): boolean
}

/** 密文正文的载荷（解密后才看得到）。 */
export interface MemoryContentPayloadV2 {
  /** 格式身份，固定 `velaros.memory.content.v2`。 */
  readonly format: 'velaros.memory.content.v2'
  /** base64 的 32 字节承诺 nonce。 */
  readonly commitmentNonce: string
  /** base64 的正文字节。 */
  readonly content: string
}

/** 密文正文的 AES-256-GCM 信封（磁盘上的 blob 字节）。 */
export interface MemoryContentEnvelopeV2 {
  /** 格式身份，固定 `velaros.memory.envelope.v2`。 */
  readonly format: 'velaros.memory.envelope.v2'
  /** 信封算法，固定 `A256GCM`。 */
  readonly algorithm: 'A256GCM'
  /** base64 的 12 字节 IV。 */
  readonly iv: string
  /** base64 的 16 字节 GCM tag。 */
  readonly tag: string
  /** base64 的密文。 */
  readonly ciphertext: string
}

/** 封存一段正文后，调用方拿到的三件东西（拿不到 DEK 与 nonce）。 */
export interface MemorySealedContentV2 {
  /** 随机 blob id（32 位小写 hex）。 */
  readonly blobId: string
  /** 随机化结构承诺 `c2:<64 hex>`。 */
  readonly commitment: string
  /** 明文字节数。 */
  readonly byteLength: number
}

/**
 * 只读取正文的窄能力面。
 * utils 不许引 impl，而擦除闭包要解开候选账本判断牵连范围，所以把它要的这一个动作单列成端口，
 * 由 `ContentKeyServiceV2` 结构上满足。
 */
export interface MemoryContentReaderV2 {
  /** 按承诺取回正文；承诺不符或密钥已销毁都抛错。 */
  openContent(blobId: string, expectedCommitment: string): Buffer
}

/** 构造内容密钥服务时的可选项。 */
export interface MemoryContentKeyServiceOptionsV2 {
  /** 随机源；不给用 node:crypto 的 randomBytes（测试可注入确定性随机）。 */
  readonly random?: (byteLength: number) => Buffer
}

/** 构造 blob 存储时的可选项。 */
export interface MemoryBlobStoreOptionsV2 {
  /** 崩溃注入钩子。 */
  readonly hooks?: StorageStepHooksV2
}

/** 密钥环里被包装的四组密钥（值都是 base64 信封，不是明文）。 */
export interface MemoryKeyringKeysV2 {
  /** 身份密钥信封。 */
  readonly identity: string
  /** 匹配键根密钥信封。 */
  readonly matchRoot: string
  /** 代号 → 派生索引代密钥信封。 */
  readonly indexGenerations: Readonly<Record<string, string>>
  /** blob id → 内容 DEK 信封。 */
  readonly contentDeks: Readonly<Record<string, string>>
}

/** 密钥环文件去掉完整性摘要的部分（摘要就是对它算的）。 */
export interface MemoryKeyringUnsignedV2 {
  /** 格式身份，固定 `velaros.memory.keyring.v2`。 */
  readonly format: 'velaros.memory.keyring.v2'
  /** 这一代的代号。 */
  readonly generation: number
  /** 这一代的创建时刻（毫秒）。 */
  readonly createdAt: number
  /** 包装这些密钥的 wrapping root id。 */
  readonly wrappingRootId: string
  /** 被包装的四组密钥。 */
  readonly keys: MemoryKeyringKeysV2
}

/** 磁盘上的密钥环代际文件。 */
export interface MemoryKeyringFileV2 extends MemoryKeyringUnsignedV2 {
  /** 对未签名部分算的 sha256，64 位小写 hex。 */
  readonly integrity: string
}

/** 打开密钥环的一次读数。 */
export interface MemoryKeyringOpenReportV2 {
  /** 生效代号。 */
  readonly generation: number
  /** 这次 open 是不是新建了初始代。 */
  readonly created: boolean
  /** 清掉的崩溃残留与旧代文件数。 */
  readonly cleanedResidueCount: number
}

/** 构造密钥环时的可选项。 */
export interface MemoryKeyringStoreOptionsV2 {
  /** 崩溃注入钩子。 */
  readonly hooks?: StorageStepHooksV2
  /** 取当前时刻的函数；不给用 Date.now。 */
  readonly now?: () => number
  /** 随机源；不给用 node:crypto 的 randomBytes。 */
  readonly random?: (byteLength: number) => Buffer
}

/** 密钥环的只读诊断读数：只给计数，不给包装字节。 */
export interface MemoryKeyringDescriptionV2 {
  /** 生效代号。 */
  readonly generation: number
  /** 当前包装这些密钥的 wrapping root id。 */
  readonly wrappingRootId: string
  /** 还在册的内容 DEK 数量。 */
  readonly contentDekCount: number
  /** 还在册的派生索引代密钥数量。 */
  readonly indexGenerationCount: number
}
