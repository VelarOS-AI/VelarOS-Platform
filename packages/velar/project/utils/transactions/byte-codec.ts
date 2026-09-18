/**
 * 事务落盘的原字节：比较两份字节、把落盘的 base64 解回字节。按原编码写回、保留没改片段原字节的编码在公共件 @velaros-ai/core/text-files。
 */

import { isUndefined } from "@velaros-ai/core";

/** 两段字节是否完全相同；都缺席算相同，只有一边缺席算不同。 */
export function bytesEqual(first?: Uint8Array, second?: Uint8Array): boolean {
  return isUndefined(first)
    ? isUndefined(second)
    : !isUndefined(second) &&
        first.length === second.length &&
        first.every((byte, index) => byte === second[index]);
}

/** 把落盘的 base64 原字节解回字节；缺席返回 undefined。 */
export function decodeStoredBytes(value?: string): Buffer | undefined {
  return isUndefined(value) ? undefined : Buffer.from(value, "base64");
}
