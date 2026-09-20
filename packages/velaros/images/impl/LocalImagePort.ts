/**
 * 本机看图端口：`LocalImagePort`，`velaros:images` 的空间端口 `ImageSpacePort` 在本机上的实现，由 `createLocalImagePort` 创建。
 * 路径可以是本机任意位置（怎么解析由宿主给的 `resolvePath` 定），读它解开符号链接之后的那个文件；
 * macOS 上用系统自带的 sips 裁图缩图，别的平台不给这个口子，view 遇到超限的图会明说。
 */

import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

import type { ImageSpacePort, LocalImagePortOptions } from '../contract/requires.js'
import type { ImageLocation, ImageResizeRequest, ImageResizeResult } from '../types/space.js'
import { resizeImageWithSips } from '../utils/sips.js'

/** 按配置建一个本机看图端口。 */
export function createLocalImagePort(options: LocalImagePortOptions): ImageSpacePort {
  return new LocalImagePort(options)
}

export class LocalImagePort implements ImageSpacePort {
  public readonly resizeImage?: (request: ImageResizeRequest) => Promise<ImageResizeResult>
  private readonly options: LocalImagePortOptions

  constructor(options: LocalImagePortOptions) {
    this.options = options
    // 只有 macOS 自带 sips；别的平台不给这个口子，而不是给一个一调就失败的。
    if ((options.platform ?? process.platform) === 'darwin') this.resizeImage = resizeImageWithSips
  }

  public async locate(path: string): Promise<ImageLocation> {
    const resolved = this.options.resolvePath(path)
    return { target: await resolveRealPath(resolved), shown: resolved }
  }
}
