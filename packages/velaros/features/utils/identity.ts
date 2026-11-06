import { AppError } from '@velaros-ai/core/error'

import { FeatureLimits } from '../contract/constants.js'

/** 原生能力和兼容导入使用同一身份边界，不接受空值或超长定位。 */
export function featureIdentity(input: { readonly id: string }): string {
  if (!input.id.trim() || input.id.length > FeatureLimits.idChars)
    throw new AppError('VALIDATION', 'Feature 身份无效')
  return input.id
}

/** 本机来源路径保持原文，只在边界拒绝空值和超长输入。 */
export function featurePath(input: { readonly path: string }): string {
  if (!input.path.trim() || input.path.length > FeatureLimits.pathChars)
    throw new AppError('VALIDATION', 'Feature 来源路径无效')
  return input.path
}
