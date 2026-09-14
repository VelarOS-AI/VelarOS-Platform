import { open } from "node:fs/promises";

import { isObject } from "@velaros-ai/core";

import { ProjectError } from "../errors.js";

/** 私有事务读取限定在预期长度内；文件增长不能触发无界 readFile 分配。 */
export async function readBoundedProjectBytes(
  path: string,
  maximumBytes: number,
): Promise<Buffer | undefined> {
  const handle = await open(path, "r").catch((error: unknown) => {
    if (isObject(error) && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes)
      throw new ProjectError(
        "CONFLICT_WITH_EXTERNAL_EDIT",
        "事务目标的类型或字节长度已变化。",
        { path, maximumBytes },
      );
    const bytes = new Uint8Array(metadata.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > metadata.size)
      throw new ProjectError(
        "CONFLICT_WITH_EXTERNAL_EDIT",
        "事务目标在读取原字节期间增长。",
        { path },
      );
    return Buffer.from(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}
