/**
 * 存储物理层专用错误码（WS3-S1）。
 *
 * 铁律：错误码与错误消息**永不携带明文内容或密钥字节**——错误面只允许结构化
 * 定位信息（blob_id 等随机标识、目录路径、代际号）。密钥材料零日志、零错误泄漏
 * 是 ContentKeyService 的构造性约束，不靠调用方自律。
 *
 * 语义：
 * - `MEMORY_STORAGE_CORRUPTION`：布局/文件损坏（integrity 失配、CURRENT 指针
 *   非法、严格 parse 拒绝、代际文件缺失等）。密钥文件的宽容解析是伪造注入面，
 *   规范 §7.2 要求未知格式一律拒开，拒绝走此码。
 * - `MEMORY_WRAPPING_ROOT_MISMATCH`：keyring 文件记录的 wrapping root 与注入的
 *   包裹端口不一致（不是损坏，是拿错了 OS 安全存储里的 root）。
 * - `MEMORY_DEK_DESTROYED`：DEK 已 crypto-shred，内容不可恢复（规范 §3.2：系统
 *   不得声称能验证已删除的原文）。与 NOT_FOUND（从未存在）语义区分。
 * - `MEMORY_BLOB_CORRUPTED`：blob 信封结构非法或 GCM 完整性校验失败。
 * - `MEMORY_COMMITMENT_MISMATCH`：解密成功但随机化承诺常数时间比较失配
 *   （规范 §3.2 验证路径）。
 */
export const MemoryStorageErrorCodesV2 = {
  corruption: 'MEMORY_STORAGE_CORRUPTION',
  wrappingRootMismatch: 'MEMORY_WRAPPING_ROOT_MISMATCH',
  dekDestroyed: 'MEMORY_DEK_DESTROYED',
  blobCorrupted: 'MEMORY_BLOB_CORRUPTED',
  commitmentMismatch: 'MEMORY_COMMITMENT_MISMATCH',
} as const

export type MemoryStorageErrorCodeV2 =
  (typeof MemoryStorageErrorCodesV2)[keyof typeof MemoryStorageErrorCodesV2]
