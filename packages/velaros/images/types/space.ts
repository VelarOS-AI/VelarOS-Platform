/**
 * 空间端口上流动的数据：定位出来的一张图、裁图缩图的请求与结果、交给模型看的一张图，以及看图的实现自己的工作类型。
 * 带 `Buffer`，所以不在可移植文件里；公开签名用到的从根入口导出，工作类型只在包内用。
 */

import type { ImageRegion, ImageResult } from './images.js'

/** 空间把模型给的路径定下来的结果：真正要读的文件（绝对路径，解开了符号链接），以及交给模型时这张图的写法。 */
export interface ImageLocation {
  target: string
  shown: string
}

/** 请宿主裁一块、缩到长边不超过 longEdge；两件事都没要求时宿主可以原样返回。 */
export interface ImageResizeRequest {
  data: Buffer
  mediaType: string
  region?: ImageRegion
  longEdge: number
}

/** 宿主裁完、缩完的图，以及它实际的尺寸与格式。 */
export interface ImageResizeResult {
  data: Buffer
  mediaType: string
  width: number
  height: number
}

/** 交给模型看的一张图：宿主经调用上下文收走，放到这次结果后面。 */
export interface ImageAttachment {
  mediaType: string
  /** base64，已经在上限以内。 */
  data: string
  /** 放在图前面的一行说明。 */
  label: string
}

/** 按文件头认出的媒体类型：模型认得的图片，或 PDF 这类文档（只用来把错误说清楚）。 */
export interface ImageMediaType {
  kind: 'image' | 'document'
  mediaType: string
}

/** 看一张图的结果：给模型看的条目、要交出去的字节，以及要了哪一块。 */
export interface ImageViewed {
  entry: ImageResult
  image: { data: Buffer; mediaType: string }
  region: Nullable<ImageRegion>
}
