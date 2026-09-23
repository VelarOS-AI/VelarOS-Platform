/**
 * 常量表：本包认识的磁盘文本编码、报错用的错误码。不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/core/text-files/contracts` 取）。
 */

/**
 * 本包能无损读回、原样写出的七种磁盘文本编码。`utf8-bom`、`utf16le`、`utf16be` 写出时带 BOM；带 `-nobom` 的是没有 BOM 的 UTF-16，字节序靠 NUL 字节的奇偶分布认出；
 * `gb18030` 同时覆盖 GBK 与 GB2312 的文件。持久化的编码名读回来时用 `textCodec.isEncoding` 核对。
 */
export const TextEncodings = Object.freeze([
  'utf8',
  'utf8-bom',
  'utf16le',
  'utf16be',
  'utf16le-nobom',
  'utf16be-nobom',
  'gb18030',
] as const)

/**
 * 本包的错误码。失败一律抛 `AppError`，`code` 就是这里的码，`context` 带 path 与出错的细节（文字里不拼路径，调用方按自己的写法加）；调用方按码翻成自己的错误。
 * 文件系统自己的 errno 错误（ENOENT、EACCES 这类）原样抛出，不包。
 */
export const TextFileErrorCodes = Object.freeze({
  /** 不是能无损解码的文本：二进制、非法字节，或认不出是哪种编码。 */
  notText: 'TEXT_FILE_NOT_TEXT',
  /** 文本没法按目标编码无损写出：含孤立代理项、有 GB18030 表示不了的字符，或按原字节保留编码的结果读回来对不上；前两种在 context 里带出错的 offset 与 codeUnit。 */
  lossy: 'TEXT_FILE_LOSSY',
  /** 写前核对或读的过程中发现文件被外部改过。 */
  externalEdit: 'TEXT_FILE_EXTERNAL_EDIT',
  /** 不是普通文件（目录、管道、设备），或是有多个硬链接的文件——原子替换会把它从其余链接上拆开。 */
  notRegular: 'TEXT_FILE_NOT_REGULAR',
  /** 文件超过调用方给的字节上限；context 带 size 与 maxBytes。 */
  tooLarge: 'TEXT_FILE_TOO_LARGE',
  /** 给的权限位不在 0 到 0777 之间。 */
  invalidMode: 'TEXT_FILE_INVALID_MODE',
} as const)
