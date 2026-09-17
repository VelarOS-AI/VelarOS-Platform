/**
 * 约定的常量表（对外合同的一部分）：`velar:files` 的错误码与公开上限。
 * 上限直接被操作方法引用，也是模型在声明里看到的数字（两边一致由验收核对）。
 * 包内可调、不对外承诺的参数不在这里，在 `utils/tuning.ts`。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./contracts` 入口出包。
 */

/**
 * `velar:files` 专属的错误码：模型的程序接住异常时 `error.code` 就是它，声明里写着这两个值。
 * 别的失败沿用 `@velaros-ai/core` 的通用码：`VALIDATION`（入参不对、文件不是文本、太大、被别人改过）、
 * `PERMISSION`（越出空间范围、用户拒绝读、没有写权限）、`NOT_FOUND`（文件或版本不存在）、`PLATFORM`（宿主做不了，比如裁不了图）。
 */
export const FileErrorCodes = Object.freeze({
  /** edit 整批定不下来（版本过期、不是文本、编不回原编码、同一个文件出现两次）：一个文件都没写，message 逐条写明每个问题。 */
  editUnresolved: 'FILES_EDIT_UNRESOLVED',
  /** edit 里有文件的写入被拒绝（用户没点头，或空间不许写）：一个文件都没写。 */
  editDenied: 'FILES_EDIT_DENIED',
} as const)

/**
 * `velar:files` 对外承诺的上限。
 *
 * `readChars` 与 `fileBytes` 必须是同一个数：两个数一旦各写各的，
 * 中间就会漏出一段「字节上限放行、字符预算拒绝」的文件，读不了也改不了。
 */
export const FileLimits = Object.freeze({
  /**
   * 一次 `read` 总共最多读回多少字符，**与单个文件的字节上限是同一个数**。
   *
   * 支持的编码里解出来的字符数都不超过字节数（UTF-8、GB18030 一个字至少一字节，UTF-16 两字节一个），
   * 所以任何过得了字节上限的文件，放进一次空的调用里一定读得下——这个预算只在**一批读好几个**时才会咬人。
   * 它保护的是这一侧的内存与 IPC，不是模型的上下文：正文落在程序的变量里，模型看不到。
   */
  readChars: 20 * 1024 * 1024,
  /** read 一次最多几个文件。 */
  readFiles: 20,
  /** view 一次最多几张图片。 */
  viewFiles: 10,
  /** edit 一次最多几个文件。 */
  editFiles: 20,
  /**
   * 交给模型的图，长边最多多少像素；超出的先压再给。
   *
   * 取 2000 对齐 API 最严的那条：一个请求里超过 20 张图时，每张都不许超过 2000 px，否则整个请求被拒。
   * 高分辨率模型本身能看到 2576，但为了那几百像素冒整请求被拒的险不值。
   */
  imageEdge: 2000,
  /**
   * 交给模型的图，**base64 之后**最多多少字节。API 按 base64 算，不是原文件大小。
   * 取 5 MB 对齐 Bedrock 与 Google Cloud（直连 API 是 10 MB）；超了就继续压。
   */
  imageBase64Bytes: 5 * 1024 * 1024,
  /** 单个文件最大多少字节：`read` 读得进来、`edit` 覆盖得了的上限；再大的用命令处理。 */
  fileBytes: 20 * 1024 * 1024,
  /**
   * 整份写入时，不超过这么大的文件会先把原内容留成一个版本，之后能 `restore` 回去；
   * 更大的照样能写，只是不留版本（结果里 `previousVersion` 为 null）——十份 20 MB 的快照放在内存里太贵。
   */
  versionedBytes: 2 * 1024 * 1024,
})
