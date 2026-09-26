/**
 * 约定的常量表（对外合同的一部分）：`velaros:files` 的错误码与公开上限。
 * 上限直接被操作方法引用，也是模型在声明里看到的数字（两边一致由验收核对）。
 * 包内可调、不对外承诺的参数不在这里，在 `utils/tuning.ts`。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./contracts` 入口出包。
 */

/**
 * `velaros:files` 专属的错误码：模型的程序接住异常时 `error.code` 就是它，声明里写着这几个值。
 * 别的失败沿用 `@velaros-ai/core` 的通用码：`VALIDATION`（入参不对、文件不是文本、太大、range 越界）、
 * `PERMISSION`（越出空间范围、文件权限不让读写）、`NOT_FOUND`（文件不存在、改动号找不到）。
 */
export const FileErrorCodes = Object.freeze({
  /** edit 整批定不下来（原文找不到或不唯一、不是文本、编不回原编码、定下改法之后文件又被改过）：一个文件都没写，message 逐条写明每个问题。 */
  editUnresolved: 'FILES_EDIT_UNRESOLVED',
  /** edit 里有文件写不了（越出空间范围，或文件权限不让读写）：一个文件都没写。 */
  editDenied: 'FILES_EDIT_DENIED',
  /** undo 时有文件在那次改动之后又被改过：一个文件都没撤，message 点名是哪几个。 */
  undoConflict: 'FILES_UNDO_CONFLICT',
} as const)

/**
 * `velaros:files` 对外承诺的上限。
 *
 * `readChars` 与 `fileBytes` 必须是同一个数：两个数一旦各写各的，
 * 中间就会漏出一段「字节上限放行、字符预算拒绝」的文件，读不了也改不了。
 */
export const FileLimits = Object.freeze({
  /**
   * 一次 `read` 总共最多交回多少字符（所有文件读到的行加起来），**与单个文件的字节上限是同一个数**。
   * 支持的编码里解出来的字符数都不超过字节数，所以任何过得了字节上限的文件，放进一次空的调用里一定读得下——
   * 这个预算只在一批读好几个时才会咬人。它保护的是这一侧的内存与 IPC，不是模型的上下文：行落在程序的变量里，模型看不到。
   */
  readChars: 20 * 1024 * 1024,
  /** read 一次最多几个文件。 */
  readFiles: 20,
  /** edit 一次最多改几个文件。 */
  editFiles: 20,
  /** edit 一次最多几步。 */
  editSteps: 1000,
  /** 单个文件最大多少字节：`read` 读得进来、`edit` 改得了的上限；再大的用命令处理。 */
  fileBytes: 20 * 1024 * 1024,
  /**
   * 改动前的原文最多留多大：不超过它的文件，改之前的内容留下来，`undo` 能整次撤回；
   * 改到更大的文件照样能改，只是这次改动撤不回（结果里 `undoable` 为 false）——十份 20 MB 的原文放在内存里太贵。
   */
  undoBytes: 2 * 1024 * 1024,
  /** 最多留最近多少次改动能撤回；更早的撤不回了。 */
  undoChanges: 50,
})
