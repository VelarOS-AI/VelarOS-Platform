import { lstat, open } from "node:fs/promises";
import { basename } from "node:path";

import { isEmpty } from "@velaros-ai/core";

import type { ArtifactManifestSnippet, LogReadSnippet, ReferencedArtifactPath, ReferencedLogPath } from '../../types/retrieval.js'

import { chatSearchRanking } from "./ranking";
import { inferArtifactType, isInternalArtifactPath, isInternalCommandLogPath, isTextArtifactPath } from "./references";
import { chatSearchText } from "./text";

/**
 * 从已打开文件句柄读取指定区间字节。
 *
 * @param handle fs open 句柄
 * @param bytesToRead 期望读取字节数
 * @param position 文件内起始偏移
 */
async function readBytes(
  handle: Awaited<ReturnType<typeof open>>,
  bytesToRead: number,
  position: number,
): Promise<Buffer> {
  if (bytesToRead <= 0) return Buffer.alloc(0);

  const buffer = Buffer.alloc(bytesToRead);
  const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
  return buffer.subarray(0, bytesRead);
}

/**
 * 启发式二进制检测：前 8KB 内出现 NUL 字节则视为二进制。
 */
function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < checkLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * 大文件采样：读文件头 headRatio 比例 + 尾部补齐 maxBytes，
 * 中间插入 `... omitted N bytes ...` 标记。
 */
async function readHeadAndTail(
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
  maxBytes: number,
  headRatio: number,
): Promise<Buffer> {
  const headBytes = Math.max(1, Math.floor(maxBytes * headRatio));
  const tailBytes = Math.max(1, maxBytes - headBytes);
  const head = await readBytes(handle, headBytes, 0);
  const tailStart = Math.max(fileSize - tailBytes, headBytes);
  const tail = await readBytes(
    handle,
    Math.max(fileSize - tailStart, 0),
    tailStart,
  );
  const marker = Buffer.from(
    `\n... omitted ${Math.max(fileSize - head.length - tail.length, 0)} bytes ...\n`,
  );
  return Buffer.concat([head, marker, tail]);
}

/**
 * 读取单条日志引用。
 *
 * @param reference path + source
 * @param maxChars 该条日志 content 字符上限（UTF-8 读盘时 maxBytes ≈ maxChars×4）
 * @param headRatio 超限时 head+tail 采样里 head 占的比例
 */
async function readReferencedLog(
  reference: ReferencedLogPath,
  maxChars: number,
  headRatio: number,
): Promise<LogReadSnippet> {
  if (!isInternalCommandLogPath(reference.path))
    return {
      ...reference,
      content: null,
      size: null,
      truncated: false,
      warning: "已跳过非内部日志路径。",
    };

  const stats = await lstat(reference.path).catch(() => null);
  if (!stats)
    return {
      ...reference,
      content: null,
      size: null,
      truncated: false,
      warning: "引用的日志文件已不存在。",
    };

  if (!stats.isFile() || stats.isSymbolicLink())
    return {
      ...reference,
      content: null,
      size: stats.size,
      truncated: false,
      warning: "引用的日志不是普通文件。",
    };

  const handle = await open(reference.path, "r").catch(() => null);
  if (!handle)
    return {
      ...reference,
      content: null,
      size: stats.size,
      truncated: false,
      warning: "无法打开引用的日志。",
    };

  try {
    const maxBytes = Math.max(maxChars * 4, 1);
    const truncated = stats.size > maxBytes;
    const buffer = truncated
      ? await readHeadAndTail(handle, stats.size, maxBytes, headRatio)
      : await readBytes(handle, stats.size, 0);

    if (isBinaryBuffer(buffer))
      return {
        ...reference,
        content: null,
        size: stats.size,
        truncated,
        warning: "引用的日志疑似二进制文件。",
      };

    return {
      ...reference,
      content: truncated
        ? chatSearchRanking.buildHeadTailSnippet(
            buffer.toString("utf-8"),
            maxChars,
          )
        : chatSearchText.truncate(buffer.toString("utf-8"), maxChars),
      size: stats.size,
      truncated,
      warning: null,
    };
  } finally {
    await handle.close().catch(() => null);
  }
}

/**
 * 读取单条 artifact：始终返回 filename/type/size；
 * 仅 text 扩展名且非二进制时填充 preview。
 *
 * @param reference path + source
 * @param previewChars preview 的最大字符数（读盘时按 ×4 估算字节上限）
 */
async function readReferencedArtifactManifest(
  reference: ReferencedArtifactPath,
  previewChars: number,
): Promise<ArtifactManifestSnippet> {
  const filename = basename(reference.path);
  const type = inferArtifactType(reference.path);

  if (!isInternalArtifactPath(reference.path))
    return {
      ...reference,
      filename,
      type,
      size: null,
      preview: null,
      warning: "已跳过非内部 artifact 路径。",
    };

  const stats = await lstat(reference.path).catch(() => null);
  if (!stats)
    return {
      ...reference,
      filename,
      type,
      size: null,
      preview: null,
      warning: "引用的 artifact 已不存在。",
    };

  if (!stats.isFile() || stats.isSymbolicLink())
    return {
      ...reference,
      filename,
      type,
      size: stats.size,
      preview: null,
      warning: "引用的 artifact 不是普通文件。",
    };

  if (!isTextArtifactPath(reference.path))
    return {
      ...reference,
      filename,
      type,
      size: stats.size,
      preview: null,
      warning: null,
    };

  const handle = await open(reference.path, "r").catch(() => null);
  if (!handle)
    return {
      ...reference,
      filename,
      type,
      size: stats.size,
      preview: null,
      warning: "无法打开引用的 artifact。",
    };

  try {
    const buffer = await readBytes(
      handle,
      Math.min(stats.size, previewChars * 4),
      0,
    );

    if (isBinaryBuffer(buffer))
      return {
        ...reference,
        filename,
        type,
        size: stats.size,
        preview: null,
        warning: "引用的 artifact 疑似二进制文件。",
      };

    return {
      ...reference,
      filename,
      type,
      size: stats.size,
      preview: chatSearchText.truncate(
        buffer.toString("utf-8"),
        previewChars,
      ),
      warning: null,
    };
  } finally {
    await handle.close().catch(() => null);
  }
}

/**
 * 批量读取日志引用，均分 `totalBudgetChars`。
 *
 * @param references 来自 `collectReferencedLogPaths` 或 `index.toolPayloads[].logReferences`
 * @param totalBudgetChars 本次读盘总字符预算（调用方按 `maxChars` 比例分配）
 * @param maxReferences 最多读几条（`ContextRetrievalReferences.maxReferencedLogs`）
 * @param headRatio 超限时 head+tail 采样里 head 占的比例
 * @returns 最多 `maxReferences` 条；空输入返回 `[]`
 *
 * `perLogBudget = max(800, totalBudgetChars / min(refs.length, maxReferences))`
 */
export async function readReferencedLogSnippets(
  references: ReferencedLogPath[],
  totalBudgetChars: number,
  maxReferences: number,
  headRatio: number,
): Promise<LogReadSnippet[]> {
  if (isEmpty(references)) return [];

  const perLogBudget = Math.max(
    800,
    Math.floor(
      totalBudgetChars /
        Math.min(
          references.length,
          maxReferences,
        ),
    ),
  );
  const snippets: LogReadSnippet[] = [];

  for (const reference of references.slice(0, maxReferences)) {
    snippets.push(await readReferencedLog(reference, perLogBudget, headRatio));
  }

  return snippets;
}

/**
 * 批量读取 artifact manifest（metadata + 可选 preview）。
 *
 * @param references 来自 collectReferencedArtifactPaths
 * @param maxReferences 最多读几条（`ContextRetrievalReferences.maxReferencedArtifacts`）
 * @param previewChars 单条 preview 的最大字符数
 * @returns 最多 maxReferences 条
 */
export async function readReferencedArtifactManifestSnippets(
  references: ReferencedArtifactPath[],
  maxReferences: number,
  previewChars: number,
): Promise<ArtifactManifestSnippet[]> {
  const snippets: ArtifactManifestSnippet[] = [];

  for (const reference of references.slice(0, maxReferences)) {
    snippets.push(await readReferencedArtifactManifest(reference, previewChars));
  }

  return snippets;
}

/**
 * 将 LogReadSnippet 列表格式化为 agent 可读的多段文本（`---` 分隔）。
 * 用于拼入 retrieveToolPayload 的 content.referencedLogs 段。
 */
export function formatLogSnippets(snippets: LogReadSnippet[]): string {
  return snippets
    .map((snippet, index) => {
      const header = [
        `#${index + 1}`,
        `path: ${snippet.path}`,
        `source: ${snippet.source}`,
        `size: ${snippet.size ?? "unknown"}`,
        `truncated: ${snippet.truncated}`,
        snippet.warning ? `警告: ${snippet.warning}` : null,
      ]
        .filter((item): item is string => Boolean(item))
        .join("\n");
      const body = snippet.content
        ? `content:\n${snippet.content}`
        : "content: <unavailable>";
      return `${header}\n${body}`;
    })
    .join("\n---\n");
}

/**
 * 将 ArtifactManifestSnippet 列表格式化为多段文本。
 * 用于 content.referencedArtifacts 段。
 */
export function formatArtifactManifests(snippets: ArtifactManifestSnippet[]): string {
  return snippets
    .map((snippet, index) => {
      const header = [
        `#${index + 1}`,
        `path: ${snippet.path}`,
        `source: ${snippet.source}`,
        `type: ${snippet.type}`,
        `filename: ${snippet.filename}`,
        `size: ${snippet.size ?? "unknown"}`,
        snippet.warning ? `警告: ${snippet.warning}` : null,
      ]
        .filter((item): item is string => Boolean(item))
        .join("\n");
      const preview = snippet.preview
        ? `preview:\n${snippet.preview}`
        : "preview: <not included>";
      return `${header}\n${preview}`;
    })
    .join("\n---\n");
}
