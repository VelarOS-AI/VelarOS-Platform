import { createHash } from "node:crypto";

export function sha256(input: string | Buffer): string {
  const h = createHash("sha256");
  h.update(input);
  return h.digest("hex");
}

export function revisionFor(path: string, contentHash: string, mtimeMs: number, size: number): string {
  return `rev_${sha256(`${path}:${contentHash}:${mtimeMs}:${size}`).slice(0, 24)}`;
}

/**
 * 轻量 revision：仅基于路径 + 修改时间 + 字节数，不读取文件内容。
 * mtimeToken 建议传纳秒级时间戳字符串，以最大限度区分相邻写入。
 * 注意：同 size + 同 mtime 的内容改动无法区分（见 revisionStrategy 文档）。
 */
export function metadataRevisionFor(path: string, mtimeToken: string, size: number): string {
  return `rev_${sha256(`meta:${path}:${mtimeToken}:${size}`).slice(0, 24)}`;
}

/** 与 metadataRevisionFor 同源的元数据指纹，用于 metadata 模式下的 snapshot.sha256 占位。 */
export function metadataFingerprint(path: string, mtimeToken: string, size: number): string {
  return sha256(`metafp:${path}:${mtimeToken}:${size}`);
}
