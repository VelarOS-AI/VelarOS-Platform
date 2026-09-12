// 域：工作区底层文件系统网关——所有读/写/列举都必须经过它，没有第二条通往 fs 的路。
//
// ## 从哪读起
//  1. `authorize`：**唯一**的准入点（根内约束 → deny glob → fileFilter），返回归一后的
//     `{ abs, rel }`。下面所有公开方法都以它开头；绕过它 = 绕过全部边界。
//  2. `snapshot` / `read`：读路径，附带 revision 与文本编码/二进制判定。
//  3. `write` / `remove` / `rename`：写路径。
//  4. `listFiles` / `observe`：遍历路径，含 gitignore 过滤。
//
// ## 安全门（挡什么、为什么门在这一层）
//  - **两段式根内约束**：`toAbs` 拦词法穿越（`../`），`assertConfinedToRoot` 对 realpath 结果
//    再拦一次软链逃逸。门放在 FileStore 而不是各调用点，是因为「新增一个调用点忘了检查」
//    在上层是查不出来的，在这里则不可能发生——上层拿不到 abs 路径。
//  - **deny glob 优先于 fileFilter provider**：`skipFileFilter` 只关宿主注入的可见性过滤器
//    （apply/rollback 需要写回自己刚写过、但对模型不可见的文件），**永远关不掉
//    `policy.readDeny/writeDeny`**。把 deny 判定挪到 skipFileFilter 之后 = 宿主一个
//    `skipFileFilter: true` 就能写 `.env`。
//  - **已知且刻意接受的 TOCTOU**：authorize 与真正的 write 之间存在时间窗，期间新建的软链
//    能逃逸。修它要 `openat` + `O_NOFOLLOW` 逐级打开（Node 无跨平台原语），代价远高于收益：
//    本包的威胁模型是「模型给出坏路径」，不是「攻击者与我们竞速」。
import { createHash } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
  isEmpty,
  isNull,
  isPresent,
  isTrue,
  isUndefined,
  optionalWhen,
  toOptional,
} from '@velaros-ai/core'

import { ProjectError } from "../errors.js";
import { validateReadBounds } from "../read-bounds.js";
import type { FileListEntry, FileStatInput, FileStatResult,ObserveInput, ReadInput, ReadResult } from "../types/io.js";
import type { CorePolicy } from "../types/policy.js";
import type { CommandProvider, FileFilterProvider } from "../types/provider.js";
import type { FileSnapshot, ProjectSnapshot } from "../types/snapshot.js";
import { type GitignoreRule, isGitignored, readAncestorGitignoreRules, readGitignoreRules } from "../utils/gitignore.js";
import { matchesAny } from "../utils/glob.js";
import { metadataFingerprint, metadataRevisionFor, revisionFor,sha256 } from "../utils/hash.js";
import { isInsideRoot,normalizeRel,toAbs, toRel } from "../utils/path.js";
import {
  decodeProjectTextBuffer,
  detectProjectTextEncoding,
  encodeProjectTextBuffer,
  isProbablyBinary,
  type ProjectTextEncoding,
  sliceLines,
} from "../utils/text.js";

const RevisionMismatchSuggestedNextAction =
  "请重新读取受影响文件，并使用最新 snapshot.revision 重试。";

const StatRecommendedMaxLines = 120;
const StatMaxLineCountBytes = 1024 * 1024;
const ReadPrefixChunkBytes = 64 * 1024;
const BinaryDetectionSampleBytes = 8000;

/** 文本切片以及继续有界读取所需的元数据。 */
interface ByteLimitedContent {
  content: string;
  truncated: boolean;
  lineCount: number;
  /** 从原始输入消费的 UTF-16 code units；可能包含为保持完整行而省略的末尾换行。 */
  consumedChars: number;
}

interface LineWindowReadResult {
  content: string;
  range: { startLine: number; endLine: number };
  hasMore: boolean;
  /** 只有读到文件末尾时才确定的总行数，计数口径与内存路径一致（按 \n 切分）。 */
  totalLines?: number;
}

type FileStoreAction = "read" | "write" | "search" | "observe";

/** listFiles 发现阶段通过全部过滤的条目；children 只在该目录被深入时填充。 */
interface ListingNode {
  readonly entry: FileListEntry;
  readonly included: boolean;
  readonly children: ListingNode[];
}

/** 待读取的目录：读到的条目挂到 children 下；rules 是从根目录累积到它父目录的 gitignore 规则。 */
interface ListingDirectory {
  readonly abs: string;
  readonly rel: string;
  readonly children: ListingNode[];
  readonly rules: readonly GitignoreRule[];
}

/** 一个目录读到的条目，连同判定它们所用的规则（根目录到该目录逐级累积）。 */
interface ListedDirectory {
  readonly directory: ListingDirectory;
  readonly rules: readonly GitignoreRule[];
  readonly entries: ReadonlyArray<{ entry: Dirent; abs: string; rel: string }>;
}

/**
 * 把路径解析到「最近一个真实存在的祖先」的 realpath，再把尚不存在的尾巴拼回去。
 *
 * 为什么不能直接 `realpath(abs)`：写入路径在检查时通常还不存在（create_file），realpath 会
 * 直接抛 ENOENT——那样要么放行未检查的路径（失败方向不安全），要么写不了新文件。逐级上溯
 * 保证「祖先目录里有软链指向 root 外」也能被下面的根内判定抓到。
 */
async function realPathPreservingMissing(absPath: string): Promise<string> {
  let current = path.resolve(absPath);
  let tail = "";
  while (true) {
    try {
      return path.resolve(await realpath(current), tail);
    } catch {
      // arch-guard:silent-catch-ok 路径可能尚未存在；继续向上寻找可 realpath 的祖先。
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(absPath);
      tail = tail ? path.join(path.basename(current), tail) : path.basename(current);
      current = parent;
    }
  }
}

async function assertConfinedToRoot(realRoot: string, abs: string, inputPath: string): Promise<void> {
  const realTarget = await realPathPreservingMissing(abs);
  if (isInsideRoot(realRoot, realTarget)) return;
  throw new ProjectError(
    "PERMISSION_DENIED",
    `路径解析后越出工作区根目录：${inputPath}`,
    { inputPath },
    "该路径或其祖先通过符号链接指向当前工作区外部。请切换到目标包的真实工作区，或只检查当前工作区源码；不要改搜该路径的父目录。",
  );
}

/** 按 UTF-8 字节数和 Unicode 字符数截断，优先保留完整行，并记录精确 UTF-16 续读 offset。 */
function limitContent(content: string, maxBytes?: number, maxChars?: number): ByteLimitedContent {
  const byteBounded = !isUndefined(maxBytes);
  const charBounded = !isUndefined(maxChars);
  if (!byteBounded && !charBounded)
    return {
      content,
      truncated: false,
      lineCount: countTextLines(content),
      consumedChars: content.length,
    };

  const encoder = new TextEncoder();
  let consumedChars = 0;
  let consumedCharacterCount = 0;
  let consumedBytes = 0;
  for (const char of content) {
    const charUnits = char.length;
    const charBytes = encoder.encode(char).length;
    if (charBounded && consumedCharacterCount + 1 > Math.max(0, maxChars!)) break;
    if (byteBounded && consumedBytes + charBytes > Math.max(0, maxBytes!)) break;
    consumedChars += charUnits;
    consumedCharacterCount += 1;
    consumedBytes += charBytes;
  }
  if (
    consumedChars === 0
    && !isEmpty(content)
    && byteBounded
    && maxBytes! > 0
    && (!charBounded || maxChars! > 0)
  ) {
    throw new ProjectError(
      "INVALID_INPUT",
      "maxBytes 小于下一个完整 UTF-8 字符所需字节数",
      { maxBytes },
      "请提高 maxBytes 后重试；读取不会返回半个 UTF-8 字符。",
    );
  }

  if (consumedChars >= content.length)
    return {
      content,
      truncated: false,
      lineCount: countTextLines(content),
      consumedChars: content.length,
    };

  const exactPrefix = content.slice(0, consumedChars);
  const lastNewline = exactPrefix.lastIndexOf("\n");
  if (lastNewline >= 0) {
    const completeLines = content.slice(0, lastNewline + 1);
    return {
      content: completeLines,
      truncated: true,
      lineCount: countTextLines(completeLines),
      consumedChars: lastNewline + 1,
    };
  }
  return {
    content: exactPrefix,
    truncated: true,
    lineCount: countTextLines(exactPrefix),
    consumedChars,
  };
}

function estimateTokensFromBytes(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / 4));
}

function countTextLines(content: string): number {
  if (isEmpty(content)) return 0;
  const newlineMatches = content.match(/\n/g)?.length ?? 0;
  return content.endsWith("\n") ? newlineMatches : newlineMatches + 1;
}

interface ReadCursor {
  line: number;
  column: number;
}

/**
 * 起始行越界不是调用错误：同一个 range 常被套用到一批长短不一的文件上，短文件越界时返回
 * 空内容与总行数并说明原因，批量里的其它文件照常推进。
 */
function readPastEnd(snapshot: FileSnapshot, startLine: number, totalLines: number): ReadResult {
  return {
    snapshot,
    content: "",
    totalLines,
    truncated: false,
    hasMore: false,
    note: `文件共 ${totalLines} 行，请求的起始行 ${startLine} 超出范围，未返回内容；如需文件末尾，请把 startLine 设为不大于 ${totalLines} 的值。`,
  };
}

/**
 * endLine 超出总行数时已按文件末尾钳制；此时 endColumn 失去参照行，只能忽略并说明。
 * 流式窗口没读到文件末尾时总行数未知，但那也说明 endLine 没有越界。
 */
function endColumnClampNote(range: NonNullable<ReadInput["range"]>, totalLines: Optional<number>): Optional<string> {
  if (isUndefined(totalLines) || isUndefined(range.endColumn) || isUndefined(range.endLine) || range.endLine <= totalLines) return undefined;
  return `endLine ${range.endLine} 超出文件总行数 ${totalLines}，已读到文件末尾并忽略 endColumn。`;
}

function sliceWindowColumns(
  filePath: string,
  content: string,
  range: ReadInput["range"],
  absoluteStartLine: number,
  absoluteEndLine: number,
): {
  content: string;
  startColumn: number;
  endColumn: number;
  hasMoreOnEndLine: boolean;
} {
  const lines = content.split("\n");
  const firstLine = lines[0] ?? "";
  const lastLine = lines.at(-1) ?? "";
  const startColumn = range?.startColumn ?? 1;
  const endColumn = range?.endLine === absoluteEndLine
    ? range.endColumn ?? lastLine.length + 1
    : lastLine.length + 1;
  if (startColumn > firstLine.length + 1) {
    throw new ProjectError(
      "INVALID_INPUT",
      `${filePath}：startColumn ${startColumn} 超出第 ${absoluteStartLine} 行长度 ${firstLine.length}`,
      { path: filePath, range, lineLength: firstLine.length },
    );
  }
  if (endColumn > lastLine.length + 1) {
    throw new ProjectError(
      "INVALID_INPUT",
      `${filePath}：endColumn ${endColumn} 超出第 ${absoluteEndLine} 行长度 ${lastLine.length}`,
      { path: filePath, range, lineLength: lastLine.length },
    );
  }
  if (lines.length === 1) {
    if (endColumn < startColumn) {
      throw new ProjectError("INVALID_INPUT", `${filePath}：同一行的 endColumn 不能早于 startColumn`, { path: filePath, range });
    }
    return {
      content: firstLine.slice(startColumn - 1, endColumn - 1),
      startColumn,
      endColumn,
      hasMoreOnEndLine: endColumn < firstLine.length + 1,
    };
  }
  const selected = [
    firstLine.slice(startColumn - 1),
    ...lines.slice(1, -1),
    lastLine.slice(0, endColumn - 1),
  ].join("\n");
  return {
    content: selected,
    startColumn,
    endColumn,
    hasMoreOnEndLine: endColumn < lastLine.length + 1,
  };
}

function advanceReadCursor(start: ReadCursor, consumed: string): ReadCursor {
  const lastNewline = consumed.lastIndexOf("\n");
  if (lastNewline === -1) return { line: start.line, column: start.column + consumed.length };
  const newlineCount = consumed.match(/\n/g)?.length ?? 0;
  return {
    line: start.line + newlineCount,
    column: consumed.length - lastNewline,
  };
}

function continuationInput(
  input: ReadInput,
  pathValue: string,
  revision: string,
  cursor: ReadCursor,
  preserveRequestedEnd: boolean,
): ReadInput {
  const range: NonNullable<ReadInput["range"]> = {
    startLine: cursor.line,
    ...(cursor.column > 1 ? { startColumn: cursor.column } : {}),
    ...(preserveRequestedEnd && !isUndefined(input.range?.endLine)
      ? { endLine: input.range.endLine }
      : {}),
    ...(preserveRequestedEnd && !isUndefined(input.range?.endColumn)
      ? { endColumn: input.range.endColumn }
      : {}),
  };
  return {
    path: pathValue,
    baseRevision: revision,
    range,
    ...(!isUndefined(input.maxBytes) ? { maxBytes: input.maxBytes } : {}),
    ...(!isUndefined(input.maxChars) ? { maxChars: Math.max(1, input.maxChars) } : {}),
    ...(!isUndefined(input.trust) ? { trust: input.trust } : {}),
  };
}

function concatByteChunks(chunks: readonly Uint8Array[]): Buffer {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return Buffer.from(combined);
}

/**
 * 写入的编码：已存在的文本文件沿用它自己的编码；路径上还没有文件时用调用方给的 `fallback`
 * （删除后回滚、重命名重建文件时是原文件的编码），都没有才用 UTF-8。
 */
async function encodeTextForOverwrite(absPath: string, content: string, fallback: Optional<ProjectTextEncoding>): Promise<Buffer> {
  try {
    const existing = await readFile(absPath);
    const existingEncoding = detectProjectTextEncoding(existing);
    if (existingEncoding) return encodeProjectTextBuffer(content, existingEncoding);
  } catch {
    // arch-guard:silent-catch-ok 新文件或瞬时不可读文件按 fallback 或默认 UTF-8 写入。
  }
  return encodeProjectTextBuffer(content, fallback);
}

async function readLimitedTextPrefix(
  absPath: string,
  fileSize: number,
  limits: { maxBytes?: number; maxChars?: number }
): Promise<{ content: string; truncated: boolean }> {
  const handle = await open(absPath, "r");
  const chunk = new Uint8Array(ReadPrefixChunkBytes);
  const chunks: Buffer[] = [];
  let bytesReadTotal = 0;
  let reachedEof = false;
  let decodedContent: Nullable<string> = "";

  try {
    while (true) {
      const decoded = !isEmpty(chunks) ? decodeProjectTextBuffer(concatByteChunks(chunks)) : "";
      const remainingChars = !isUndefined(limits.maxChars)
        ? Math.max(0, limits.maxChars - [...(decoded ?? "")].length)
        : undefined;
      const charByteBudget = !isUndefined(remainingChars)
        ? remainingChars * 4 + 4
        : ReadPrefixChunkBytes;
      const remainingBytes = !isUndefined(limits.maxBytes)
        ? Math.min(limits.maxBytes - bytesReadTotal, charByteBudget)
        : charByteBudget;
      if (remainingBytes <= 0) break;
      const readSize = Math.min(chunk.length, remainingBytes);
      const { bytesRead } = await handle.read(chunk, 0, readSize, null);
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }

      bytesReadTotal += bytesRead;
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      const content = decodeProjectTextBuffer(concatByteChunks(chunks)) ?? "";
      if (!isUndefined(limits.maxChars) && [...content].length >= limits.maxChars) {
        break;
      }
      if (!isUndefined(limits.maxBytes) && bytesReadTotal >= limits.maxBytes) break;
    }

    decodedContent = !isEmpty(chunks) ? decodeProjectTextBuffer(concatByteChunks(chunks)) : "";
    let lookaheadBytes = 0;
    while (
      (isNull(decodedContent) || (isEmpty(decodedContent) && bytesReadTotal < fileSize))
      && bytesReadTotal < fileSize
      && lookaheadBytes < 8
    ) {
      const { bytesRead } = await handle.read(chunk, 0, 1, null);
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      bytesReadTotal += bytesRead;
      lookaheadBytes += bytesRead;
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      decodedContent = decodeProjectTextBuffer(concatByteChunks(chunks));
    }
  } finally {
    await handle.close();
  }

  if (isNull(decodedContent)) {
    throw new ProjectError(
      "INVALID_INPUT",
      "读取预算无法覆盖下一个完整文本字符",
      { maxBytes: limits.maxBytes, maxChars: limits.maxChars },
      "请提高 maxBytes 或 maxChars 后重试；读取不会返回无法解码的字符片段。",
    );
  }
  return {
    content: decodedContent,
    truncated: !reachedEof && bytesReadTotal < fileSize,
  };
}

async function readTextLineWindow(
  absPath: string,
  range: {
    startLine?: number;
    endLine?: number;
    startColumn?: number;
    endColumn?: number;
  },
  limits: { maxBytes?: number; maxChars?: number } = {},
): Promise<LineWindowReadResult> {
  const startLine = Math.max(1, Math.floor(range.startLine ?? 1));
  const requestedEndLine = Math.max(
    startLine,
    Number.isFinite(range.endLine)
      ? Math.floor(range.endLine ?? startLine)
      : Number.MAX_SAFE_INTEGER
  );
  const handle = await open(absPath, "r");
  const chunk = new Uint8Array(ReadPrefixChunkBytes);
  const lines: string[] = [];
  const chunks: Buffer[] = [];
  let currentLine = 1;
  let hasMore = false;
  let totalLines: Optional<number>;
  const outputLimitCandidates = [limits.maxBytes, limits.maxChars].filter(
    (value): value is number => !isUndefined(value),
  );
  const outputLimit = !isEmpty(outputLimitCandidates)
    ? Math.min(...outputLimitCandidates)
    : undefined;

  const acceptLine = (line: string) => {
    if (currentLine < startLine) {
      currentLine++;
      return false;
    }
    if (currentLine <= requestedEndLine) {
      lines.push(line);
      currentLine++;
      return false;
    }
    hasMore = true;
    return true;
  };

  try {
    while (!hasMore) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;

      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      const decoded = decodeProjectTextBuffer(concatByteChunks(chunks)) ?? "";
      const parts = decoded.split("\n");
      if (!isUndefined(outputLimit) && parts.length >= startLine) {
        const lastRequestedPart = Math.min(parts.length, requestedEndLine);
        const partialWindow = parts.slice(startLine - 1, lastRequestedPart).join("\n");
        const requiredChars = Math.max(0, (range.startColumn ?? 1) - 1) + outputLimit + 1;
        if (partialWindow.length >= requiredChars) {
          lines.length = 0;
          lines.push(...partialWindow.split("\n"));
          hasMore = true;
          break;
        }
      }
      const completeParts = decoded.endsWith("\n") ? parts : parts.slice(0, -1);
      currentLine = 1;
      lines.length = 0;
      for (const line of completeParts) {
        if (acceptLine(line)) break;
      }
    }

    if (!hasMore) {
      const decoded = decodeProjectTextBuffer(concatByteChunks(chunks)) ?? "";
      const parts = decoded.split("\n");
      totalLines = parts.length;
      currentLine = 1;
      lines.length = 0;
      for (const line of parts) {
        if (acceptLine(line)) break;
      }
    }
  } finally {
    await handle.close();
  }

  return {
    content: lines.join("\n"),
    range: {
      startLine,
      endLine: Math.max(startLine, startLine + lines.length - 1),
    },
    hasMore,
    totalLines,
  };
}

async function hashFileAndDetectBinary(absPath: string): Promise<{ hash: string; binary: boolean }> {
  const handle = await open(absPath, "r");
  const hash = createHash("sha256");
  const chunk = new Uint8Array(ReadPrefixChunkBytes);
  let binarySample: Uint8Array | undefined;

  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, bytesRead);
      hash.update(view);
      if (!binarySample) {
        binarySample = view.slice(0, BinaryDetectionSampleBytes);
      }
    }
  } finally {
    await handle.close();
  }

  return {
    hash: hash.digest("hex"),
    binary: isProbablyBinary(binarySample ?? new Uint8Array()),
  };
}

/** metadata 模式下只读文件头部样本判定是否二进制，避免为算哈希整文件读取。 */
async function detectBinaryByPrefix(absPath: string): Promise<boolean> {
  const handle = await open(absPath, "r");
  try {
    const chunk = new Uint8Array(BinaryDetectionSampleBytes);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    return isProbablyBinary(chunk.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function normalizeFilterList(values: LooseOptional<readonly string[]>): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

/** 底层文件系统网关，统一执行根目录约束、策略、过滤器和 revision 管理。 */
export class FileStore {
  readonly root: string;
  private fileFilter?: FileFilterProvider;
  private command: CommandProvider;
  private policy: CorePolicy;
  private realRoot?: Promise<string>;

  constructor(
    root: string,
    policy: CorePolicy,
    fileFilter: LooseOptional<FileFilterProvider>,
    command: CommandProvider
  ) {
    this.root = path.resolve(root);
    this.policy = policy;
    this.fileFilter = toOptional(fileFilter);
    this.command = command;
  }

  private async allowed(
    rel: string,
    action: FileStoreAction,
    options?: { skipFileFilter?: boolean }
  ): Promise<boolean> {
    // 顺序是安全语义的一部分：deny glob 是硬策略，必须先判且 skipFileFilter 关不掉；
    // fileFilter 只是宿主注入的可见性过滤器，apply/rollback 写回时可以显式跳过。
    const deny = action === "write" ? this.policy.writeDeny : this.policy.readDeny;
    if (matchesAny(rel, deny)) return false;
    if (options?.skipFileFilter || !this.fileFilter) return true;
    return this.fileFilter.shouldInclude({ path: rel, action });
  }

  private getRealRoot(): Promise<string> {
    this.realRoot ??= realPathPreservingMissing(this.root);
    return this.realRoot;
  }

  /** 只做路径规范化和可见性判断，不读取或写入文件内容。 */
  public async authorize(
    pathInput: string,
    action: FileStoreAction,
    deniedActionLabel: string,
    options?: { skipFileFilter?: boolean }
  ): Promise<{ abs: string; rel: string }> {
    const abs = toAbs(this.root, pathInput);
    await assertConfinedToRoot(await this.getRealRoot(), abs, pathInput);
    const rel = toRel(this.root, abs);
    if (!(await this.allowed(rel, action, options))) {
      throw new ProjectError("PERMISSION_DENIED", `${deniedActionLabel}被拒绝：${rel}`);
    }
    return { abs, rel };
  }

  /** 读取文件或目录的元数据，并按需附带文本内容。 */
  public async snapshot(
    pathInput: string,
    includeContent = true,
    options?: { skipFileFilter?: boolean }
  ): Promise<FileSnapshot> {
    // 所有公开读写路径都先按工作区根目录规范化。
    const { abs, rel } = await this.authorize(pathInput, "read", "读取", {
      skipFileFilter: options?.skipFileFilter,
    });
    // 用 bigint stat 一次拿到纳秒级 mtime：metadata 模式据此区分相邻写入，content 模式仍按毫秒计算保持兼容。
    let st: BigIntStats;
    try {
      st = await stat(abs, { bigint: true });
    } catch {
      // arch-guard:silent-catch-ok stat 失败表示文件当前不可见，按 missing snapshot 返回。
      const ident = this.identity(rel, 0, "0", 0, sha256("missing"));
      return {
        path: rel,
        absPath: abs,
        exists: false,
        isDirectory: false,
        isBinary: false,
        size: 0,
        sha256: ident.sha256,
        revision: ident.revision,
        mtimeMs: 0,
        adapterIds: [],
      };
    }
    const size = Number(st.size);
    const mtimeMs = Number(st.mtimeMs);
    const mtimeToken = st.mtimeNs.toString();
    const metadataMode = this.policy.revisionStrategy === "metadata";

    const isDirectory = st.isDirectory();
    if (isDirectory) {
      const contentHash = sha256(`directory:${rel}:${mtimeMs}`);
      const ident = this.identity(rel, mtimeMs, mtimeToken, size, contentHash);
      return {
        path: rel,
        absPath: abs,
        exists: true,
        isDirectory: true,
        isBinary: false,
        size,
        sha256: ident.sha256,
        revision: ident.revision,
        mtimeMs,
        adapterIds: [],
      };
    }
    let content: string | undefined;
    let textEncoding: Nullable<ProjectTextEncoding> = null;
    let binary: boolean;
    // contentHash 仅在 content 模式下参与计算；metadata 模式整文件读取/哈希都被跳过。
    let contentHash = "";
    if (includeContent && size <= this.policy.maxFileSizeToReadBytes) {
      const data = await readFile(abs);
      textEncoding = detectProjectTextEncoding(data);
      binary = isNull(textEncoding);
      if (!metadataMode) {
        contentHash = sha256(data);
      }
      if (!binary) {
        content = decodeProjectTextBuffer(data) ?? "";
      }
    } else if (metadataMode) {
      // 轻量路径：不读全文，仅取头部样本判定二进制。
      binary = await detectBinaryByPrefix(abs);
    } else {
      const metadata = await hashFileAndDetectBinary(abs);
      binary = metadata.binary;
      contentHash = metadata.hash;
    }
    const ident = this.identity(rel, mtimeMs, mtimeToken, size, contentHash);
    const base: FileSnapshot = {
      path: rel,
      absPath: abs,
      exists: true,
      isDirectory: false,
      isBinary: binary,
      size,
      encoding: binary ? "binary" : "utf8",
      sha256: ident.sha256,
      revision: ident.revision,
      mtimeMs,
      adapterIds: [],
    };
    if (isPresent(content)) {
      base.content = content;
    }
    if (isPresent(textEncoding) && textEncoding !== "utf8") {
      base.textEncoding = textEncoding;
    }
    // stat 跟随链接取到的是目标文件；删除/重命名作用于链接本身，需要知道路径是不是链接。
    if ((await lstat(abs)).isSymbolicLink()) {
      base.isSymbolicLink = true;
    }
    return base;
  }

  /**
   * 按当前 revisionStrategy 计算 snapshot 的 revision 与 sha256：
   * metadata 模式只用 path+纳秒 mtime+size，content 模式用传入的内容哈希。
   */
  private identity(
    rel: string,
    mtimeMs: number,
    mtimeToken: string,
    size: number,
    contentHash: string
  ): { revision: string; sha256: string } {
    if (this.policy.revisionStrategy === "metadata") return {
        revision: metadataRevisionFor(rel, mtimeToken, size),
        sha256: metadataFingerprint(rel, mtimeToken, size),
      };
    return { revision: revisionFor(rel, contentHash, mtimeMs, size), sha256: contentHash };
  }

  /** 按范围、字节数或字符数限制读取文本内容。 */
  public async read(
    input: ReadInput,
    options?: { skipFileFilter?: boolean }
  ): Promise<ReadResult> {
    validateReadBounds(input);
    const snap = await this.snapshot(input.path, true, options);
    if (input.baseRevision && snap.revision !== input.baseRevision) {
      throw new ProjectError(
        "BASE_REVISION_MISMATCH",
        `${snap.path} 的 revision 不匹配`,
        {
          expected: input.baseRevision,
          actual: snap.revision,
        },
        RevisionMismatchSuggestedNextAction,
      );
    }
    if (!snap.exists || snap.isDirectory || snap.isBinary) return { snapshot: snap };
    const hasRange = !!input.range && [
      input.range.startLine,
      input.range.endLine,
      input.range.startColumn,
      input.range.endColumn,
    ].some((value) => !isUndefined(value));
    const hasLimit = !isUndefined(input.maxBytes) || !isUndefined(input.maxChars);
    if (isUndefined(snap.content) && !hasLimit && !hasRange) {
      throw new ProjectError(
        "NOT_SUPPORTED",
        `文件超过完整读取上限：${snap.path}`,
        {
          size: snap.size,
          maxFileSizeToReadBytes: this.policy.maxFileSizeToReadBytes,
        },
        "请读取有界范围，或传入 maxBytes。",
      );
    }
    if (isUndefined(snap.content) && !hasRange && hasLimit) {
      const prefix = await readLimitedTextPrefix(snap.absPath, snap.size, {
        maxBytes: input.maxBytes,
        maxChars: input.maxChars,
      });
      const limited = limitContent(prefix.content, input.maxBytes, input.maxChars);
      const truncated = prefix.truncated || limited.truncated;
      const cursor = advanceReadCursor(
        { line: 1, column: 1 },
        prefix.content.slice(0, limited.consumedChars),
      );
      return {
        snapshot: snap,
        content: limited.content,
        totalLines: optionalWhen(!truncated, countTextLines(prefix.content)),
        truncated,
        hasMore: truncated,
        nextStartLine: optionalWhen(truncated && cursor.column === 1, cursor.line),
        continuation: optionalWhen(
          truncated,
          continuationInput(input, snap.path, snap.revision, cursor, true),
        ),
      };
    }

    if (isUndefined(snap.content) && hasRange) {
      const range = input.range!;
      const window = await readTextLineWindow(snap.absPath, {
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
      }, {
        maxBytes: input.maxBytes,
        maxChars: input.maxChars,
      });
      const requestedStartLine = range.startLine ?? 1;
      if (isPresent(window.totalLines) && requestedStartLine > window.totalLines)
        return readPastEnd(snap, requestedStartLine, window.totalLines);
      const selected = sliceWindowColumns(
        snap.path,
        window.content,
        range,
        window.range.startLine,
        window.range.endLine,
      );
      const limited = limitContent(selected.content, input.maxBytes, input.maxChars);
      const startCursor = { line: window.range.startLine, column: selected.startColumn };
      const limitedCursor = advanceReadCursor(
        startCursor,
        selected.content.slice(0, limited.consumedChars),
      );
      const cursor = limited.truncated
        ? limitedCursor
        : selected.hasMoreOnEndLine
          ? { line: window.range.endLine, column: selected.endColumn }
          : { line: window.range.endLine + 1, column: 1 };
      const hasMore = limited.truncated || selected.hasMoreOnEndLine || window.hasMore;
      return {
        snapshot: snap,
        content: limited.content,
        range: {
          startLine: window.range.startLine,
          startColumn: selected.startColumn,
          endLine: limited.truncated ? limitedCursor.line : window.range.endLine,
          endColumn: limited.truncated ? limitedCursor.column : selected.endColumn,
        },
        truncated: hasMore,
        hasMore,
        nextStartLine: optionalWhen(hasMore && cursor.column === 1, cursor.line),
        continuation: optionalWhen(
          hasMore,
          continuationInput(input, snap.path, snap.revision, cursor, limited.truncated),
        ),
        note: endColumnClampNote(range, window.totalLines),
      };
    }

    const rawContent = snap.content ?? await readFile(snap.absPath, "utf8");
    const allLines = rawContent.split("\n");
    const totalLines = allLines.length;

    if (hasRange) {
      const range = input.range!;
      const requestedStartLine = range.startLine ?? 1;
      if (requestedStartLine > totalLines) return readPastEnd(snap, requestedStartLine, totalLines);
      const sliced = sliceLines(rawContent, range.startLine, range.endLine);
      const selected = sliceWindowColumns(
        snap.path,
        sliced.content,
        range,
        sliced.range.startLine,
        sliced.range.endLine,
      );
      const limited = limitContent(selected.content, input.maxBytes, input.maxChars);
      const startCursor = { line: sliced.range.startLine, column: selected.startColumn };
      const limitedCursor = advanceReadCursor(
        startCursor,
        selected.content.slice(0, limited.consumedChars),
      );
      const cursor = limited.truncated
        ? limitedCursor
        : selected.hasMoreOnEndLine
          ? { line: sliced.range.endLine, column: selected.endColumn }
          : { line: sliced.range.endLine + 1, column: 1 };
      const hasMore = limited.truncated || selected.hasMoreOnEndLine || sliced.range.endLine < totalLines;
      const remainingLines = hasMore
        ? Math.max(0, totalLines - cursor.line + (cursor.column > 1 ? 1 : 0))
        : 0;
      return {
        snapshot: snap,
        content: limited.content,
        range: {
          startLine: sliced.range.startLine,
          startColumn: selected.startColumn,
          endLine: limited.truncated ? limitedCursor.line : sliced.range.endLine,
          endColumn: limited.truncated ? limitedCursor.column : selected.endColumn,
        },
        totalLines,
        truncated: hasMore,
        hasMore,
        nextStartLine: optionalWhen(hasMore && cursor.column === 1, cursor.line),
        remainingLines: optionalWhen(hasMore, remainingLines),
        continuation: optionalWhen(
          hasMore,
          continuationInput(input, snap.path, snap.revision, cursor, limited.truncated),
        ),
        note: endColumnClampNote(range, totalLines),
      };
    }

    const limited = limitContent(rawContent, input.maxBytes, input.maxChars);
    const cursor = advanceReadCursor(
      { line: 1, column: 1 },
      rawContent.slice(0, limited.consumedChars),
    );
    const hasMore = limited.truncated;
    return {
      snapshot: snap,
      content: limited.content,
      totalLines,
      truncated: limited.truncated,
      hasMore,
      nextStartLine: optionalWhen(hasMore && cursor.column === 1, cursor.line),
      remainingLines: optionalWhen(
        hasMore,
        Math.max(0, totalLines - cursor.line + (cursor.column > 1 ? 1 : 0)),
      ),
      continuation: optionalWhen(
        hasMore,
        continuationInput(input, snap.path, snap.revision, cursor, true),
      ),
    };
  }

  /** 返回轻量文件状态和建议的安全读取窗口。 */
  public async stat(
    input: FileStatInput,
    options?: { skipFileFilter?: boolean }
  ): Promise<FileStatResult> {
    // stat 比 read 更轻量，并返回推荐的安全读取窗口。
    // 这里取 includeContent=true：对可读文本文件复用同一次读取的正文来数行数，
    // 避免「先为哈希读一遍、再为行数读一遍」的重复整文件读取。
    const snap = await this.snapshot(input.path, true, options);
    const warnings: string[] = [];

    if (!snap.exists) {
      warnings.push("文件不存在。");
      return {
        path: snap.path,
        absolutePath: snap.absPath,
        exists: false,
        kind: "missing",
        sizeBytes: 0,
        estimatedTokens: null,
        lineCount: null,
        isBinary: false,
        readableText: false,
        mtimeMs: null,
        revision: null,
        recommendedRead: null,
        warnings,
      };
    }

    // 复用 snapshot 已做的 bigint stat：snapshot 已携带 size / mtimeMs / isDirectory，
    // 不再为 stat 结果重复发一次 stat() 系统调用。snapshot 把存在的非目录项一律按文件读取，
    // 因此走到这里的「存在且非目录」项即视作常规文件（fifo 等异常项在 snapshot 读取阶段已退化为 missing）。
    const kind = snap.isDirectory ? "directory" : "file";
    const sizeBytes = snap.size;
    const mtimeMs = snap.mtimeMs;
    const estimatedTokens = kind === "file" ? estimateTokensFromBytes(sizeBytes) : null;

    if (kind !== "file") {
      warnings.push(kind === "directory" ? "目标是目录。" : "目标不是常规文件。");
      return {
        path: snap.path,
        absolutePath: snap.absPath,
      exists: true,
      kind,
      sizeBytes,
      estimatedTokens,
      lineCount: null,
      isBinary: snap.isBinary,
      readableText: false,
      mtimeMs,
        revision: snap.revision,
        recommendedRead: null,
        warnings,
      };
    }

    if (snap.isBinary) {
      warnings.push("文件看起来是二进制。");
      return {
        path: snap.path,
        absolutePath: snap.absPath,
        exists: true,
        kind,
        sizeBytes,
        estimatedTokens,
        lineCount: null,
        isBinary: true,
        readableText: false,
        mtimeMs,
        revision: snap.revision,
        recommendedRead: null,
        warnings,
      };
    }

    let lineCount: Nullable<number> = null;
    if (sizeBytes <= StatMaxLineCountBytes) {
      // 优先复用 snapshot 已读到的正文；仅当宿主把读取上限调得比行数上限更小时才回退到再读一次。
      const text = snap.content ?? (await readFile(snap.absPath, "utf8"));
      lineCount = countTextLines(text);
    } else {
      warnings.push("文件较大；stat 阶段未计算行数。");
    }

    const endLine = isNull(lineCount) ? StatRecommendedMaxLines : Math.min(lineCount, StatRecommendedMaxLines);

    return {
      path: snap.path,
      absolutePath: snap.absPath,
      exists: true,
      kind,
      sizeBytes,
      estimatedTokens,
      lineCount,
      isBinary: false,
      readableText: true,
      mtimeMs,
      revision: snap.revision,
      recommendedRead: endLine > 0 ? { path: snap.path, range: { startLine: 1, endLine } } : null,
      warnings,
    };
  }

  /**
   * 写入文本文件，并返回写入后的 snapshot。既有文本文件沿用自己的编码；`encoding` 只在路径上还没有
   * 文件时生效，供删除后回滚、重命名重建文件时沿用原文件的编码。
   */
  public async write(
    pathInput: string,
    content: string,
    options?: { skipFileFilter?: boolean; encoding?: ProjectTextEncoding }
  ): Promise<FileSnapshot> {
    const { abs, rel } = await this.authorize(pathInput, "write", "写入", options);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, await encodeTextForOverwrite(abs, content, options?.encoding));
    return this.snapshot(rel, true, { skipFileFilter: true });
  }

  /** 删除工作区内的单个文件。 */
  public async remove(
    pathInput: string,
    options?: { skipFileFilter?: boolean }
  ): Promise<void> {
    const { abs } = await this.authorize(pathInput, "write", "删除", options);
    await rm(abs, { force: true, recursive: false });
  }

  /** 在工作区内重命名或移动文件。 */
  public async rename(from: string, to: string): Promise<void> {
    const fromAccess = await this.authorize(from, "write", "重命名");
    const toAccess = await this.authorize(to, "write", "重命名");
    await mkdir(path.dirname(toAccess.abs), { recursive: true });
    await rename(fromAccess.abs, toAccess.abs);
  }

  /**
   * 列出工作区内符合过滤条件的文件和目录。
   *
   * gitignore 过滤默认开启，并从根目录到起点逐级继承各级 .gitignore：从子目录开始列举与从根目录
   * 遍历到这里，对同一路径给出同一判定。缺省时若显式起点本身就被忽略，是调用方点名要看这个目录，
   * 照常列出其内容而不再过滤；显式传 `excludeGitignored: true` 时被忽略的起点返回空。
   */
  public async listFiles(input: ObserveInput = {}): Promise<FileListEntry[]> {
    const out: FileListEntry[] = [];
    const max = input.maxFiles ?? 5000;
    const recursive = !!input.recursive;
    const maxDepth = input.maxDepth ?? (recursive ? 3 : 1);
    const include = normalizeFilterList(input.include);
    const exclude = normalizeFilterList(input.exclude);
    const startPathInput = input.path?.trim();
    const hasExplicitStartPath = !!startPathInput && startPathInput !== ".";
    const startAccess = startPathInput
      ? await this.authorize(startPathInput, "observe", "列出", { skipFileFilter: true })
      : { abs: this.root, rel: "." };
    const startDir = startAccess.abs;
    const startRel = startAccess.rel || ".";
    let gitCheckIgnoreUnavailable = false;

    const gitCheckIgnoredPaths = async (paths: string[]): Promise<Nullable<Set<string>>> => {
      const candidates = [...new Set(paths.map((item) => normalizeRel(item)).filter(Boolean))];
      if (gitCheckIgnoreUnavailable || isEmpty(candidates)) return null;

      try {
        // 优先使用 git 自己的 ignore 引擎，它比本地解析更能覆盖边界情况。-z 只有和 --stdin
        // 共用才生效：路径以 NUL 分隔经 stdin 传入，也不受命令行长度限制。
        const result = await this.command.run({
          command: "git",
          args: ["check-ignore", "--no-index", "--stdin", "-z"],
          cwd: this.root,
          stdin: candidates.join("\0"),
          timeoutMs: 10_000,
        });

        // 退出码 1 表示没有任何路径被忽略，不是失败。
        if (result.exitCode === 1) return new Set();
        if (result.exitCode !== 0) {
          gitCheckIgnoreUnavailable = true;
          return null;
        }

        return new Set(
          result.stdout
            .split("\0")
            .filter(Boolean)
            .map((item) => normalizeRel(item).replace(/\/$/, ""))
        );
      } catch {
        // arch-guard:silent-catch-ok git check-ignore 不可用时回退到本地 gitignore 解析。
        gitCheckIgnoreUnavailable = true;
        return null;
      }
    };

    // 一批路径只起一次 git check-ignore；git 不可用时按每条路径所在目录累积的本地规则判定。
    const ignoredAmong = async (
      candidates: ReadonlyArray<{ rel: string; rules: readonly GitignoreRule[] }>
    ): Promise<Set<string>> => {
      const gitIgnored = await gitCheckIgnoredPaths(candidates.map(({ rel }) => rel));
      return gitIgnored ?? new Set(candidates.filter(({ rel, rules }) => isGitignored(rel, rules)).map(({ rel }) => rel));
    };

    const requestsGitignoreExclusion = input.excludeGitignored ?? true;
    const ancestorGitignoreRules = requestsGitignoreExclusion
      ? await readAncestorGitignoreRules(this.root, startRel)
      : [];
    const startIgnored = requestsGitignoreExclusion
      && startRel !== "."
      && (await ignoredAmong([{ rel: startRel, rules: ancestorGitignoreRules }])).has(startRel);
    if (startIgnored && isTrue(input.excludeGitignored)) return out;
    const excludeGitignored = requestsGitignoreExclusion && !startIgnored;

    // 发现：按层读取目录，每层全部条目的忽略判定合成一次 git 调用——逐目录各起一个 git 进程会让
    // 递归列举慢一个数量级。被忽略、被排除或不可见的目录不再深入；已发现的可输出条目够 maxFiles
    // 后不再读下一层，工作量随请求的输出规模收敛。
    const topLevel: ListingNode[] = [];
    let level: ListingDirectory[] = [{ abs: startDir, rel: startRel, children: topLevel, rules: ancestorGitignoreRules }];
    let discovered = 0;
    for (let depth = 1; depth <= maxDepth && !isEmpty(level) && discovered < max; depth += 1) {
      const listed: ListedDirectory[] = [];
      for (const directory of level) {
        let entries: Dirent[];
        try {
          entries = await readdir(directory.abs, { withFileTypes: true });
        } catch {
          // arch-guard:silent-catch-ok 目录读取失败时跳过该子树，保持 listFiles best-effort。
          continue;
        }
        const rules = excludeGitignored
          ? [...directory.rules, ...(await readGitignoreRules(this.root, directory.rel))]
          : [];
        listed.push({
          directory,
          rules,
          entries: entries.map((entry) => {
            const abs = path.join(directory.abs, entry.name);
            return { entry, abs, rel: normalizeRel(path.relative(this.root, abs)) };
          }),
        });
      }
      const ignored = excludeGitignored
        ? await ignoredAmong(listed.flatMap(({ rules, entries }) => entries.map(({ rel }) => ({ rel, rules }))))
        : new Set<string>();
      const nextLevel: ListingDirectory[] = [];
      for (const { directory, rules, entries } of listed) {
        for (const { entry, abs, rel } of entries) {
          if (ignored.has(rel)) continue;
          if (!isEmpty(exclude) && matchesAny(rel, exclude)) continue;
          const action = entry.isDirectory() ? "observe" : "search";
          let outputRel = rel;
          if (entry.isSymbolicLink()) {
            const access = await this.authorize(
              rel,
              action,
              entry.isDirectory() ? "遍历" : "搜索",
              { skipFileFilter: hasExplicitStartPath }
            ).catch(() => null);
            if (!access) continue;
            outputRel = access.rel;
          } else if (!(await this.allowed(rel, action, { skipFileFilter: hasExplicitStartPath }))) {
            continue;
          }
          const node: ListingNode = {
            entry: { path: outputRel, type: entry.isDirectory() ? "directory" : "file" },
            included: isEmpty(include) || matchesAny(rel, include),
            children: [],
          };
          directory.children.push(node);
          if (node.included) discovered += 1;
          if (entry.isDirectory() && recursive && depth < maxDepth) {
            nextLevel.push({ abs, rel, children: node.children, rules });
          }
        }
      }
      level = nextLevel;
    }

    // 输出：按深度优先顺序（目录后紧跟其内容）收集命中 include 的条目，满 maxFiles 即止。
    const emit = (nodes: readonly ListingNode[]): void => {
      for (const node of nodes) {
        if (out.length >= max) return;
        if (node.included) out.push(node.entry);
        emit(node.children);
      }
    };
    emit(topLevel);
    return out;
  }

  /** 构建工作区文件快照列表，不默认读取文件正文。 */
  public async observe(input: ObserveInput = {}): Promise<ProjectSnapshot> {
    // observe 默认递归扫描整个工作区。
    const entries = await this.listFiles({ ...input, recursive: input.recursive ?? true, maxDepth: input.maxDepth ?? 20 });
    const snapshots: ProjectSnapshot["files"] = [];
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      try {
        const snap = await this.snapshot(entry.path, false, { skipFileFilter: true });
        snapshots.push({
          path: snap.path,
          size: snap.size,
          sha256: snap.sha256,
          revision: snap.revision,
          mtimeMs: snap.mtimeMs,
          isBinary: snap.isBinary,
          adapterIds: snap.adapterIds,
        });
      } catch {
        // arch-guard:silent-catch-ok 文件可能被 provider/policy 动态拒绝，observe 按 best-effort 跳过。
      }
    }
    const revision = revisionFor("project", sha256(snapshots.map((s) => `${s.path}:${s.sha256}`).join("\n")), Date.now(), snapshots.length);
    return { root: this.root, revision, files: snapshots, createdAt: Date.now() };
  }
}
