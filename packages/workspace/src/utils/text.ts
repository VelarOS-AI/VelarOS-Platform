import * as iconv from "iconv-lite";

import { isEmpty, isPresent } from '@velaros-ai/core'

import type { Range } from "../types/common.js";

export type WorkspaceTextEncoding =
  | "utf8"
  | "utf8-bom"
  | "utf16le"
  | "utf16be"
  | "utf16le-nobom"
  | "utf16be-nobom"
  | "gb18030";

const UTF8_BOM = new Uint8Array([0xEF, 0xBB, 0xBF]);
const UTF16LE_BOM = new Uint8Array([0xFF, 0xFE]);
const UTF16BE_BOM = new Uint8Array([0xFE, 0xFF]);

export function isProbablyBinary(data: Buffer | Uint8Array): boolean {
  return !detectWorkspaceTextEncoding(data);
}

export function decodeWorkspaceTextBuffer(data: Buffer | Uint8Array): Nullable<string> {
  const buffer = Buffer.from(data);
  const encoding = detectWorkspaceTextEncoding(buffer);
  if (!encoding) return null;

  switch (encoding) {
    case "utf8-bom":
      return buffer.subarray(UTF8_BOM.length).toString("utf-8");
    case "utf16le":
      return buffer.subarray(UTF16LE_BOM.length).toString("utf16le");
    case "utf16be":
      return decodeUtf16Be(buffer.subarray(UTF16BE_BOM.length));
    case "utf16le-nobom":
      return buffer.subarray(0, buffer.length - (buffer.length % 2)).toString("utf16le");
    case "utf16be-nobom":
      return decodeUtf16Be(buffer);
    case "gb18030":
      return decodeGb18030(buffer);
    case "utf8":
      return buffer.toString("utf-8");
  }
}

export function encodeWorkspaceTextBuffer(
  content: string,
  encoding: WorkspaceTextEncoding = "utf8"
): Buffer {
  switch (encoding) {
    case "utf8-bom":
      return prefixBytes(UTF8_BOM, Buffer.from(content, "utf-8"));
    case "utf16le":
      return prefixBytes(UTF16LE_BOM, Buffer.from(content, "utf16le"));
    case "utf16be":
      return prefixBytes(UTF16BE_BOM, encodeUtf16Be(content));
    case "utf16le-nobom":
      return Buffer.from(content, "utf16le");
    case "utf16be-nobom":
      return encodeUtf16Be(content);
    case "gb18030":
      return encodeGb18030(content);
    case "utf8":
      return Buffer.from(content, "utf-8");
  }
}

export function detectWorkspaceTextEncoding(data: Buffer | Uint8Array): Nullable<WorkspaceTextEncoding> {
  const buffer = Buffer.from(data);
  if (startsWithBytes(buffer, UTF8_BOM)) return "utf8-bom";
  if (startsWithBytes(buffer, UTF16LE_BOM)) return "utf16le";
  if (startsWithBytes(buffer, UTF16BE_BOM)) return "utf16be";

  const utf16NoBom = detectUtf16NoBom(buffer);
  if (utf16NoBom) return utf16NoBom;

  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return null;
  }
  if (canDecodeStrictly(buffer, "utf-8")) return "utf8";
  if (canDecodeStrictly(buffer, "gb18030")) return "gb18030";
  return null;
}

function startsWithBytes(buffer: Uint8Array, prefix: Uint8Array): boolean {
  if (buffer.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (buffer[index] !== prefix[index]) return false;
  }
  return true;
}

function prefixBytes(prefix: Uint8Array, payload: Buffer): Buffer {
  const combined = new Uint8Array(prefix.length + payload.length);
  combined.set(prefix, 0);
  combined.set(payload, prefix.length);
  return Buffer.from(combined);
}

function detectUtf16NoBom(buffer: Buffer): Nullable<WorkspaceTextEncoding> {
  let checkLength = Math.min(buffer.length, 8192);
  checkLength -= checkLength % 2;
  if (checkLength < 16) return null;

  let evenNul = 0;
  let oddNul = 0;
  for (let index = 0; index < checkLength; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index % 2 === 0) {
      evenNul += 1;
    } else {
      oddNul += 1;
    }
  }

  const half = checkLength / 2;
  if (oddNul * 10 >= half * 3 && evenNul * 20 <= half) return "utf16le-nobom";
  if (evenNul * 10 >= half * 3 && oddNul * 20 <= half) return "utf16be-nobom";
  return null;
}

function decodeUtf16Be(buffer: Buffer): string {
  const alignedLength = buffer.length - (buffer.length % 2);
  const swapped = new Uint8Array(alignedLength);
  for (let index = 0; index < alignedLength; index += 2) {
    swapped[index] = buffer[index + 1] ?? 0;
    swapped[index + 1] = buffer[index] ?? 0;
  }
  return Buffer.from(swapped).toString("utf16le");
}

function encodeUtf16Be(content: string): Buffer {
  const le = Buffer.from(content, "utf16le");
  const swapped = new Uint8Array(le.length);
  for (let index = 0; index < le.length; index += 2) {
    swapped[index] = le[index + 1] ?? 0;
    swapped[index + 1] = le[index] ?? 0;
  }
  return Buffer.from(swapped);
}

function canDecodeStrictly(buffer: Buffer, encoding: "utf-8" | "gb18030"): boolean {
  try {
    new TextDecoder(encoding, { fatal: true }).decode(buffer);
    return true;
  } catch {
    // arch-guard:silent-catch-ok 编码探测只关心是否能严格解码。
    return false;
  }
}

function decodeGb18030(buffer: Buffer): string {
  return new TextDecoder("gb18030", { fatal: false }).decode(buffer);
}

function encodeGb18030(content: string): Buffer {
  return iconv.encode(content, "gb18030");
}

export function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

export function lineToOffset(content: string, line: number): number {
  if (line <= 1) return 0;
  let current = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      current++;
      if (current === line) return i + 1;
    }
  }
  return content.length;
}

export function rangeFromOffsets(content: string, startOffset: number, endOffset: number): Range {
  const startLine = offsetToLine(content, startOffset);
  const endLine = offsetToLine(content, endOffset);
  const startLineOffset = lineToOffset(content, startLine);
  const endLineOffset = lineToOffset(content, endLine);
  const startColumn = startOffset - startLineOffset + 1;
  const endColumn = endOffset - endLineOffset + 1;
  return {
    startLine,
    endLine,
    startOffset,
    endOffset,
    startColumn: Math.max(1, startColumn),
    endColumn: Math.max(1, endColumn),
  };
}

export function sliceLines(content: string, startLine?: number, endLine?: number): { content: string; range: Range } {
  const lines = content.split(/\n/);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? lines.length);
  const selected = lines.slice(start - 1, end).join("\n");
  return { content: selected, range: { startLine: start, endLine: end } };
}

export function countChangedLines(diff: string): number {
  return diff.split("\n").filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))).length;
}

export function uniqueIndexOf(content: string, needle: string): { index: number; count: number } {
  if (isEmpty(needle)) return { index: -1, count: 0 };
  let count = 0;
  let index = -1;
  let from = 0;
  while (true) {
    const found = content.indexOf(needle, from);
    if (found === -1) break;
    if (count === 0) index = found;
    count++;
    from = found + Math.max(1, needle.length);
  }
  return { index, count };
}

export interface LineEndingAwareTextMatch {
  index: number;
  count: number;
  matchedText: string;
  replacementText?: string;
}

export function resolveLineEndingAwareTextMatch(content: string, needle: string, replacementText?: string): LineEndingAwareTextMatch {
  if (shouldTryCrlfMatch(content, needle)) {
    const crlfNeedle = toCrlfText(needle);
    const crlf = uniqueIndexOf(content, crlfNeedle);
    if (crlf.count !== 0) return {
        ...crlf,
        matchedText: crlfNeedle,
        replacementText: isPresent(replacementText) ? toCrlfText(replacementText) : replacementText,
      };
  }

  const direct = uniqueIndexOf(content, needle);
  return { ...direct, matchedText: needle, replacementText };
}

export function includesLineEndingAware(content: string, needle: string): boolean {
  return resolveLineEndingAwareTextMatch(content, needle).count > 0;
}

export function adaptTextToContentLineEndings(content: string, text: string): string {
  return shouldTryCrlfMatch(content, text) ? toCrlfText(text) : text;
}

function shouldTryCrlfMatch(content: string, needle: string): boolean {
  return content.includes("\r\n") && needle.includes("\n") && !needle.includes("\r\n");
}

function toCrlfText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
}
