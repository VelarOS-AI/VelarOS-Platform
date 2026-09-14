import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isObject, isPresent, isUndefined } from "@velaros-ai/core";

import { ProjectError } from "../errors.js";
import type { ProjectTextEncoding } from "../types/text.js";
import {
  detectProjectTextEncoding,
  encodeProjectTextBuffer,
} from "../utils/text.js";

import { readBoundedProjectBytes } from "./private-byte-io.js";

function isMissing(error: unknown): boolean {
  return isObject(error) && "code" in error && error.code === "ENOENT";
}

export interface ProjectExpectedBytes {
  readonly exists: boolean;
  readonly bytes?: Uint8Array;
}

/** 私有字节写入与文本写入共享原子替换、权限和持久化边界。 */
export async function atomicWriteProjectBytes(
  path: string,
  bytes: Uint8Array,
  mode?: number,
  expected?: ProjectExpectedBytes,
): Promise<void> {
  return atomicWrite(path, () => Buffer.from(bytes), mode, expected, false);
}

/** 调用方先执行根目录/权限校验；在同目录写完整临时文件再 rename，保留软链接及文件 mode。 */
export async function atomicWriteProjectText(
  path: string,
  content: string,
  fallback?: ProjectTextEncoding,
  fallbackMode?: number,
): Promise<void> {
  return atomicWrite(
    path,
    (bytes) => {
      const detected = bytes ? detectProjectTextEncoding(bytes) : fallback;
      if (bytes && !detected)
        throw new ProjectError(
          "NOT_SUPPORTED",
          "现有文件无法无损解码，拒绝文本覆盖。",
          { path },
        );
      return encodeProjectTextBuffer(content, detected ?? fallback);
    },
    fallbackMode,
  );
}

async function atomicWrite(
  path: string,
  encode: (bytes?: Buffer) => Buffer,
  fallbackMode?: number,
  expected?: ProjectExpectedBytes,
  readExisting = true,
): Promise<void> {
  if (
    isPresent(fallbackMode) &&
    (!Number.isInteger(fallbackMode) ||
      fallbackMode < 0 ||
      fallbackMode > 0o777)
  ) {
    throw new ProjectError(
      "INVALID_INPUT",
      "文件权限必须是 0 到 0777 的普通权限位。",
      { path },
    );
  }
  const entry = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  const target = entry?.isSymbolicLink() ? await realpath(path) : path;
  const existing = entry?.isSymbolicLink() ? await lstat(target) : entry;
  if (existing && (!existing.isFile() || existing.nlink > 1)) {
    throw new ProjectError(
      "NOT_SUPPORTED",
      "原子文本写入需要普通文件或指向普通文件的软链接；多硬链接文件需要独立处理。",
      { path },
    );
  }
  const bytes =
    existing && (readExisting || expected)
      ? expected
        ? await readBoundedProjectBytes(target, expected.bytes?.length ?? 0)
        : await readFile(target)
      : undefined;
  const assertExpected = (current?: Buffer) => {
    if (
      expected &&
      (expected.exists !== !isUndefined(current) ||
        (expected.exists &&
          (!expected.bytes ||
            !current ||
            current.length !== expected.bytes.length ||
            !current.every((byte, index) => byte === expected.bytes![index]))))
    )
      throw new ProjectError(
        "CONFLICT_WITH_EXTERNAL_EDIT",
        "字节写入前检测到外部修改。",
        { path },
      );
  };
  assertExpected(bytes);
  // 编码失败必须发生在创建临时文件之前。
  const encoded = encode(bytes);
  const temporary = join(dirname(target), `.velaros-write-${randomUUID()}.tmp`);
  const mode = existing ? existing.mode & 0o777 : fallbackMode;
  const handle = await open(temporary, "wx", mode ?? 0o666);
  try {
    // 已捕获的权限必须精确恢复；新文件的默认权限仍由 umask 收紧。
    if (isPresent(mode)) await handle.chmod(mode);
    await handle.writeFile(encoded);
    await handle.sync();
    await handle.close();
    if (expected) {
      const current = await readBoundedProjectBytes(
        target,
        expected.bytes?.length ?? 0,
      );
      assertExpected(current);
    }
    await rename(temporary, target);
    if (process.platform !== "win32") {
      const directory = await open(dirname(target), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}
