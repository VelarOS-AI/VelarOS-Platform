/**
 * 包内可调参数：只放数字，每项一句说明。
 * 对外承诺的上限（协议资源上限、尺寸缺省）不在这里，在 `contract/constants.ts`。
 */

/** 解析与文档生成里的两个循环预算：改它们不影响对外契约，只影响单次处理的深度。 */
export const HtmlArtifactTuning = Object.freeze({
  /** 协议解析：一个 chunk 内最多把缓冲区推进多少轮；推不动或轮数用尽就把尾巴留给下一个 chunk。 */
  bufferPassesPerChunk: 100,
  /** 源码归一化：最多剥几层外层包装（CDATA、Markdown 代码围栏），够用又不至于对着恶意输入空转。 */
  sourceUnwrapPasses: 3,
} as const)
