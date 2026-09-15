/**
 * 产品面：本包交给外面的四件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发。
 * 没有注入面：本包不需要宿主塞任何东西。这里的每个接口都必须从根入口导出。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { TextCodecApi } from '../impl/TextCodec.js'
export type { TextEncodingProbeApi } from '../impl/TextEncodingProbe.js'
export type { TextFileIoApi } from '../impl/TextFileIo.js'
export type { TextStreamDecoderApi } from '../impl/TextStreamDecoder.js'
