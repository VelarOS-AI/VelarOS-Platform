/** view 的入参核对：入参来自模型的程序，程序只查过语法、不查类型，数值范围、空字符串、错形状都在这里拦。 */

import { isArray, isFiniteNumber, isPlainObject, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ImageLimits } from '../contract/constants.js'
import type { ImageViewItem } from '../types/images.js'

/**
 * 取出一批图：files 要是 1 到 10 项的数组，每项是带 path 的对象，region 给了就得是四个有限数、宽高是正数。
 * 不合法就当场拒绝（`VALIDATION`），一张都不看。
 */
export function viewItems(input: unknown): readonly ImageViewItem[] {
  const files = isPlainObject(input) ? input.files : undefined
  if (!isArray(files))
    throw new AppError('VALIDATION', '缺少 files：view 要 { files: [...] }，每张图一项')
  if (files.length < 1) throw new AppError('VALIDATION', 'files 是空的；至少给一张图')
  if (files.length > ImageLimits.viewFiles)
    throw new AppError(
      'VALIDATION',
      `view 一次最多 ${ImageLimits.viewFiles} 张，这里给了 ${files.length} 张；分几次调用`
    )
  return files.map((file, index) => {
    if (!isPlainObject(file) || !isString(file.path) || !file.path.trim())
      throw new AppError('VALIDATION', `files[${index}] 要是 { path: 'a.png' } 这样带 path 的对象`)
    if (!isPresent(file.region)) return { path: file.path }
    const region = file.region
    const values = isPlainObject(region) ? [region.x, region.y, region.width, region.height] : []
    if (
      values.length !== 4 ||
      !values.every((value) => isFiniteNumber(value)) ||
      (values[2] as number) <= 0 ||
      (values[3] as number) <= 0
    ) {
      throw new AppError(
        'VALIDATION',
        `files[${index}].region 要 { x, y, width, height }，按原图像素算，宽高是正数`
      )
    }
    const [x, y, width, height] = values as number[]
    return { path: file.path, region: { x: x!, y: y!, width: width!, height: height! } }
  })
}
