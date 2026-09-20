/**
 * 可移植数据：`velaros:images` 的入参与结果。只从常量表 import type，不带函数、不用 Node 类型，浏览器和渲染进程都能用；
 * 从 `@velaros-ai/velaros/images/contracts` 取。
 */

/** @AgentView 图上的一块，按原图的像素算。 */
export interface ImageRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * @AgentView
 * 一张图片。给 region 就只看那一块（超出图的部分会收进来）。
 * 大图会被压小再给你；压完看不清的地方，拿 region 把那一块单独要来看。
 */
export interface ImageViewItem {
  path: string
  region?: ImageRegion
}

/** @AgentView 一批最多 10 张，单个图片文件最大 20 MB（再大的先用命令缩小）。 */
export interface ImageViewInput {
  files: ImageViewItem[]
}

/** @AgentView width、height 是原图的尺寸；sent 是实际给你看的尺寸，比原图（或 region）小就说明压过。 */
export interface ImageResult {
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
 * @AgentView
 * 一批里某张图看不了：只有它这一项是失败，其余照常；全部失败时整个调用才报错。path 照传入的原样。
 * 它和成功那支**没有判别字段**，用 `'error' in file` 分开（`file.error` 在联合上取不到）。
 */
export interface ImageFailure {
  path: string
  error: {
    code: string
    message: string
  }
}

/**
 * @AgentView
 * files 与入参的 files 一一对应。**图片本身不在这里**：调用 view 就把图交给你了，
 * 程序跑完之后按顺序放在结果后面，每张前面有一行说明是哪个文件。
 * 图**只给你看一次**：你一回应它就撤出上下文（那行说明还在），要再看就再调一次 view。
 */
export interface ImageViewResult {
  files: Array<ImageResult | ImageFailure>
}
