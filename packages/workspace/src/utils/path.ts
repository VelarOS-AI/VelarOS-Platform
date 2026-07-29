import * as path from "node:path";

import { WorkspaceError } from "../errors.js";

export function normalizeRel(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 判断 abs 是否落在 rootAbs 之内。必须带路径分隔符边界，否则像
 * `/workspace-evil/x`（兄弟目录）会被裸 `startsWith("/workspace")` 误判为「在内」。
 */
function isInsideRoot(rootAbs: string, abs: string): boolean {
  if (abs === rootAbs) return true;
  const boundary = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  return abs.startsWith(boundary);
}

export function toAbs(root: string, relOrAbs: string): string {
  const abs = path.resolve(root, relOrAbs);
  const rootAbs = path.resolve(root);
  if (!isInsideRoot(rootAbs, abs)) {
    throw new WorkspaceError("PERMISSION_DENIED", `路径越出工作区根目录：${relOrAbs}`);
  }
  return abs;
}

export function toRel(root: string, absOrRel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(root, absOrRel);
  return normalizeRel(path.relative(rootAbs, abs));
}

export function ext(input: string): string {
  return path.extname(input).toLowerCase();
}

export function dirname(input: string): string {
  return path.dirname(input);
}
