/**
 * 看图能力（`velar:images`）的操作：`ImageOperations` 与整个进程唯一的 `imageOperations`。接口 `ImageOperationsApi` 在本文件的类上方。
 * 一份实现挂在每个空间上，空间之间的差别全由调用上下文里的端口 `ImageSpacePort` 给：路径能到哪儿、许不许看、由谁来裁图缩图。
 */

import { isPresent, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { PlatformCompatibilityApi } from '@velaros-ai/platform'
import { currentPlatform } from '@velaros-ai/platform'

import { ImageLimits } from '../contract/constants.js'
import type { ImageOperationContext } from '../contract/requires.js'
import type { ImageViewInput, ImageViewItem, ImageViewResult } from '../types/images.js'
import type { ImageResizeRequest, ImageViewed } from '../types/space.js'
import { base64Length, clampImageRegion, detectMediaType, readImageFile, readImageSize, shrinkImageToLimits } from '../utils/image.js'
import { viewItems } from '../utils/input.js'

const log = Log.tag('ImageOperations')

/**
 * @AgentView
 * 看图：把 PNG、JPEG、GIF、WebP 交到你眼前。路径怎么写、能到哪儿由当前空间决定（环境报告里写着），越界的那一张看不了。
 * 在上限以内（长边 2000 px、base64 后 5 MB）的图原样给你；超了先压小，要看细节就用 region 单独要那一块。
 * 文本文件用读文件的能力读；PDF 与其他文档不在这里看。
 */
export interface ImageOperationsApi {
  /** @AgentView 看一批图片（最多 10 张）：图交给你看，返回值里只有尺寸。 */
  view(input: ImageViewInput, ctx: ImageOperationContext): Promise<ImageViewResult>
}

export class ImageOperations implements ImageOperationsApi {
  constructor(private readonly platform: PlatformCompatibilityApi) {}

  public async view(input: ImageViewInput, ctx: ImageOperationContext): Promise<ImageViewResult> {
    ctx.abortSignal.throwIfAborted()
    const items = viewItems(input)
    const attach = ctx.attachImage
    if (!attach) throw new AppError('PLATFORM', '这个宿主没有把图交给模型的通道，view 用不了')
    const files: ImageViewResult['files'] = []
    let firstFailure: Nullable<AppError> = null
    for (const [index, item] of items.entries()) {
      ctx.abortSignal.throwIfAborted()
      try {
        const viewed = await this.viewOne(item, ctx)
        const where = viewed.region ? `，区域 ${viewed.region.x},${viewed.region.y} ${viewed.region.width}×${viewed.region.height}` : ''
        attach({
          mediaType: viewed.image.mediaType,
          data: viewed.image.data.toString('base64'),
          label: `图片 ${index + 1}/${items.length}：${viewed.entry.path}（原图 ${viewed.entry.width}×${viewed.entry.height}${where}，给你的是 ${viewed.entry.sent.width}×${viewed.entry.sent.height}）`,
        })
        files.push(viewed.entry)
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('one image in a view batch failed', { code: failure.code })
        firstFailure ??= failure
        files.push({ path: String(item.path), error: { code: failure.code, message: failure.message } })
      }
    }
    if (firstFailure && files.every((file) => 'error' in file)) throw firstFailure
    return { files }
  }

  /**
   * 看一张图：在上限以内、又没要求裁的，原样交出去；超了或要裁，才请宿主处理。
   * 大多数图不用动——压分辨率只是给超限的图兜底，裁一块只在模型自己要放大看时才发生。
   */
  private async viewOne(item: ImageViewItem, ctx: ImageOperationContext): Promise<ImageViewed> {
    const { target, shown } = await ctx.images.locate(this.platform.normalizeUserPathInput(item.path))
    const buffer = await readImageFile(target, shown, ImageLimits.fileBytes)
    const media = detectMediaType(buffer)
    if (media?.kind !== 'image') {
      throw new AppError('VALIDATION', media
        ? `${shown} 是 PDF；view 只看图片，文档不在这里读`
        : `${shown} 不是能看的图片（PNG、JPEG、GIF、WebP）；文本文件用读文件的能力读，别的格式先转换`)
    }
    const size = readImageSize(buffer, media.mediaType)
    if (!size) throw new AppError('VALIDATION', `${shown} 的图片头读不出宽高（或者宽高是 0），文件可能坏了`)
    const region = isPresent(item.region) ? clampImageRegion(item.region, size) : null
    if (isPresent(item.region) && !region) throw new AppError('VALIDATION', `region 整块都在图外：${shown} 是 ${size.width}×${size.height}`)

    const fits = !region
      && Math.max(size.width, size.height) <= ImageLimits.edge
      && base64Length(buffer.byteLength) <= ImageLimits.base64Bytes
    if (fits) {
      const entry = { path: shown, mediaType: media.mediaType, width: size.width, height: size.height, sent: { ...size } }
      return { entry, image: { data: buffer, mediaType: media.mediaType }, region }
    }

    const resize = ctx.images.resizeImage
    if (!resize) {
      throw new AppError('PLATFORM', region
        ? '这个宿主裁不了图；先用命令把那一块裁出来再看'
        : `${shown} 是 ${size.width}×${size.height}，超过长边 ${ImageLimits.edge} px 或 ${ImageLimits.base64Bytes} 字节的上限，这个宿主压不了；先用命令缩小（macOS：sips -Z ${ImageLimits.edge} 原图 --out 新图；装了 ImageMagick 的：magick 原图 -resize ${ImageLimits.edge}x${ImageLimits.edge} 新图）`)
    }
    const request: Omit<ImageResizeRequest, 'longEdge'> = { data: buffer, mediaType: media.mediaType }
    if (region) request.region = region
    const shrunk = await shrinkImageToLimits(resize, request, { longEdge: ImageLimits.edge, base64Bytes: ImageLimits.base64Bytes })
    const entry = { path: shown, mediaType: shrunk.mediaType, width: size.width, height: size.height, sent: { width: shrunk.width, height: shrunk.height } }
    return { entry, image: { data: shrunk.data, mediaType: shrunk.mediaType }, region }
  }
}

/** 整个进程只有一份的看图操作；宿主把它挂在代码面的 `images` 命名空间上，每次调用时把自己空间的端口塞进 ctx。 */
export const imageOperations: ImageOperationsApi = new ImageOperations(currentPlatform)
