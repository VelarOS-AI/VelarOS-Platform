import { diffChars } from "diff";

import { isUndefined } from "@velaros-ai/core";

import { ProjectError } from "../errors.js";
import type { ProjectTextEncoding } from "../types/text.js";
import {
  decodeProjectTextBuffer,
  encodeProjectTextBuffer,
} from "../utils/text.js";

/** GB18030 的别名字节可能对应同一字符；有界差异定位到的未改片段复用原字节。 */
export function encodePreservingProjectBytes(
  original: Uint8Array,
  before: string,
  after: string,
  encoding: ProjectTextEncoding,
): Buffer {
  if (before === after) return Buffer.from(original);
  if (encoding !== "gb18030") return encodeProjectTextBuffer(after, encoding);
  const offsets = new Uint32Array(before.length + 1).fill(0xffffffff);
  let byte = 0;
  let unit = 0;
  while (byte < original.length && unit < before.length) {
    offsets[unit] = byte;
    const lead = original[byte]!;
    byte +=
      lead <= 0x80
        ? 1
        : original[byte + 1]! >= 0x30 && original[byte + 1]! <= 0x39
          ? 4
          : 2;
    unit += before.codePointAt(unit)! > 0xffff ? 2 : 1;
  }
  offsets[unit] = byte;
  if (byte !== original.length || unit !== before.length)
    throw new ProjectError("INVALID_INPUT", "原始字节与文本坐标不一致。");
  const changes = diffChars(before, after, {
    maxEditLength: 4096,
    timeout: 50,
  });
  const parts: Buffer[] = [];
  let from = 0;
  if (changes) {
    for (const change of changes) {
      if (change.added)
        parts.push(encodeProjectTextBuffer(change.value, encoding));
      else {
        const end = from + change.value.length;
        if (!change.removed)
          parts.push(
            Buffer.from(original.subarray(offsets[from], offsets[end])),
          );
        from = end;
      }
    }
  } else {
    // 极端差异退回线性前后缀；时间上限不会演变成无界 Myers 搜索。
    let prefix = 0;
    while (
      prefix < before.length &&
      prefix < after.length &&
      before[prefix] === after[prefix]
    )
      prefix += 1;
    if (offsets[prefix] === 0xffffffff) prefix -= 1;
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - suffix - 1] === after[after.length - suffix - 1]
    )
      suffix += 1;
    if (offsets[before.length - suffix] === 0xffffffff) suffix -= 1;
    parts.push(
      Buffer.from(original.subarray(0, offsets[prefix])),
      encodeProjectTextBuffer(
        after.slice(prefix, after.length - suffix),
        encoding,
      ),
      Buffer.from(original.subarray(offsets[before.length - suffix])),
    );
  }
  const combined = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  const result = Buffer.from(combined);
  if (decodeProjectTextBuffer(result) !== after)
    throw new ProjectError("INVALID_INPUT", "字节编辑无法无损表示目标文本。");
  return result;
}

export function bytesEqual(first?: Uint8Array, second?: Uint8Array): boolean {
  return isUndefined(first)
    ? isUndefined(second)
    : !isUndefined(second) &&
        first.length === second.length &&
        first.every((byte, index) => byte === second[index]);
}

export function decodeStoredBytes(value?: string): Buffer | undefined {
  return isUndefined(value) ? undefined : Buffer.from(value, "base64");
}
