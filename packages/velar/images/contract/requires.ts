/**
 * 注入面：`velar:images` 要空间塞进来的东西。本包只从这些口子接收外部能力，别处不留钩子。
 *
 * - 空间端口 `ImageSpacePort`：每个挂 `velar:images` 的空间给一份——路径能到哪儿、许不许看、由谁来裁图缩图，都由它说了算。
 * - 调用上下文 `ImageOperationContext`：宿主分发每一次调用时装好。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { ImageAttachment, ImageLocation, ImageResizeRequest, ImageResizeResult } from '../types/space.js'

/**
 * `velar:images` 的空间端口：作用域与缩图两件事。空间之间的差别全落在这里，模型那边因此只有一套说明：
 * 系统空间的路径是本机任意位置，项目空间的钳在项目内、还要过项目的读取策略。
 */
export interface ImageSpacePort {
  /**
   * 把模型给的路径定下来：交回真正要读的文件（绝对路径，解开符号链接之后的）与交给模型时这张图的写法。
   * 越出这个空间的范围、或者空间不许读时抛 `PERMISSION`；批量里只是这一张看不了。
   */
  locate: (path: string) => Promise<ImageLocation>
  /** 裁一块、缩到长边不超过 longEdge（可选）：宿主有图像处理能力时给。没有时，超出上限的图与要区域的请求都会明说做不了，而不是悄悄交一张超限的图。 */
  resizeImage?: (request: ImageResizeRequest) => Promise<ImageResizeResult>
}

/** 每次调用 `velar:images` 时宿主给的上下文。它不是模型能填的入参：宿主分发这次调用时按当前空间装好，生成声明时整个丢掉。 */
export interface ImageOperationContext {
  /** 本次调用的取消信号：每张图之间都核对。 */
  abortSignal: AbortSignal
  /** 这个空间的端口：作用域与缩图都经它。 */
  images: ImageSpacePort
  /** 把一张图交给模型看：宿主收着，在这次结果后面按顺序放出来。没有这个通道时 view 用不了。 */
  attachImage?: (image: ImageAttachment) => void
}
