// SubAgentProgressLedger 用到的纯函数（不碰实例状态）。
/** 归一化文本：小写 + 折叠空白 + 去首尾，使「语义相同、排版不同」的提示词命中同一指纹。 */
export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** djb2 字符串散列，仅用于把长提示词压成紧凑、稳定的指纹键（非加密用途）。 */
export function hashText(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}
