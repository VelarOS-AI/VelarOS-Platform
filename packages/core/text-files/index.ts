/**
 * 文本文件根入口（`@velaros-ai/core/text-files`），给 Node 宿主：认编码、严格解码、按原编码无损写回，原子写入、有界读、流式读。
 * 另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：编解码、流式编码识别、按块解码、文件读写 ─────────────────
export type { TextCodecApi } from './impl/TextCodec.js'
export { textCodec } from './impl/TextCodec.js'
export type { TextEncodingProbeApi } from './impl/TextEncodingProbe.js'
export type { TextFileIoApi } from './impl/TextFileIo.js'
export { textFileIo } from './impl/TextFileIo.js'
export type { TextStreamDecoderApi } from './impl/TextStreamDecoder.js'
