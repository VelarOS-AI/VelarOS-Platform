import { ContextTuning } from './tuning.js'

/** Gear 滚动指纹只用于寻找边界；块身份另由 SHA-256 核对。 */
export function contextBodyChunks(body: Uint8Array): readonly Uint8Array[] {
  const chunks: Uint8Array[] = []
  let start = 0
  let fingerprint = 0
  for (let offset = 0; offset < body.byteLength; offset++) {
    const value = body[offset]! + 1
    const gear = Math.imul(value, 0x9e3779b1) ^ (Math.imul(value, 0x85ebca6b) >>> 16)
    fingerprint = ((fingerprint << 1) + gear) >>> 0
    const length = offset + 1 - start
    if (
      length >= ContextTuning.bodyChunkMinBytes &&
      ((fingerprint & ContextTuning.bodyChunkBoundaryMask) === 0 ||
        length >= ContextTuning.bodyChunkMaxBytes)
    ) {
      chunks.push(body.subarray(start, offset + 1))
      start = offset + 1
      fingerprint = 0
    }
  }
  if (start < body.byteLength) chunks.push(body.subarray(start))
  return chunks
}
