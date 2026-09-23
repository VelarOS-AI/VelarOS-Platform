/** 可调参数：只放数字，每项一句说明、每项都有人用。 */
export const TextFileTuning = Object.freeze({
  /** 编码识别（TextEncodingProbe）。 */
  encoding: Object.freeze({
    /** 识别编码时留多少字节的文件头：BOM 与无 BOM 的 UTF-16（按 NUL 字节的奇偶分布）只看这一段。 */
    headBytes: 8 * 1024,
  }),
  /** 流式读（TextFileIo）。 */
  stream: Object.freeze({
    /** 流式识别编码、流式解码正文时每块读多少字节。 */
    chunkBytes: 64 * 1024,
  }),
  /** GB18030 按原字节保留编码（utils/preserving.ts）的字符级差异。 */
  preserving: Object.freeze({
    /** 字符级差异最多找多长的编辑距离；超过就退回按前后缀对齐。 */
    maxEditLength: 4_096,
    /** 字符级差异最多算多少毫秒；超时同样退回按前后缀对齐。 */
    timeoutMs: 50,
  }),
})
