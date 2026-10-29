/**
 * 看图：把 PNG、JPEG、GIF、WebP 交到你眼前。路径怎么写、能到哪儿由当前空间决定（环境报告里写着），越界的那一张看不了。
 * 在上限以内（长边 2000 px、base64 后 4 MB）的图原样给你；超了先压小，要看细节就用 region 单独要那一块。
 * 多次调用共享下一帧的 20 张、base64 合计 20 MB 容量。调用成功只表示已归档；以帧的 attached 状态确认是否看到了图。
 * 若帧标 deferred，先释放已看结果的租约，再按原路径分批 view；memory.read 只读归档 JSON，不会重新展示像素。
 * 文本文件用读文件的能力读；PDF 与其他文档不在这里看。
 */
declare module 'velaros:images' {
  /** 看一批图片（最多 10 张）：图交给你看，返回值里只有尺寸。
   */
  export function view(input: ImageViewInput): Promise<ImageViewResult>

  /** 一批最多 10 张，单个图片文件最大 20 MB（再大的先用命令缩小）。 */
  interface ImageViewInput {
    files: ImageViewItem[]
  }

  /**
   * files 与入参的 files 一一对应。**图片本身不在这里**：调用 view 把图归档等待交付，
   * 程序跑完之后，帧里的 attached 状态才代表图片实际交付；deferred 没有交付，不能声称已看。
   * 图片随结果租约进入后续帧；分批查看时先用 memory.release 释放旧结果，再按原路径 view 下一批。
   */
  interface ImageViewResult {
    files: Array<ImageResult | ImageFailure>
  }

  /**
   * 一张图片。给 region 就只看那一块（超出图的部分会收进来）。
   * 大图会被压小再给你；压完看不清的地方，拿 region 把那一块单独要来看。
   */
  interface ImageViewItem {
    path: string
    region?: ImageRegion
  }

  /** width、height 是原图的尺寸；sent 是实际给你看的尺寸，比原图（或 region）小就说明压过。 */
  interface ImageResult {
    path: string
    mediaType: string
    width: number
    height: number
    sent: {
      width: number
      height: number
    }
  }

  /**
   * 一批里某张图看不了：只有它这一项是失败，其余照常；全部失败时整个调用才报错。path 照传入的原样。
   * 它和成功那支**没有判别字段**，用 `'error' in file` 分开（`file.error` 在联合上取不到）。
   */
  interface ImageFailure {
    path: string
    error: {
      code: string
      message: string
    }
  }

  /** 图上的一块，按原图的像素算。 */
  interface ImageRegion {
    x: number
    y: number
    width: number
    height: number
  }
}
