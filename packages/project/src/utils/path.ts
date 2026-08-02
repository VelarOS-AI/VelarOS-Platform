// 域：工作区根目录约束的路径原语（词法归一 + 根内判定）。
//
// **安全门（改这里要想清楚）**：工作区的「不许越出 root」是**两层**门，两层都长在本文件的
// `isInsideRoot` 上：
//   1. **词法层** `toAbs`：`path.resolve` 归一后比边界，拦 `../../etc/passwd` 这类穿越；
//   2. **符号链接层** `FileStore.authorize`：对 realpath 解析后的真实路径再比一次，拦
//      「root 内的软链指向 root 外」。只有第 1 层时，一个 `ln -s / root/escape` 就能读全盘。
// 两层必须共用同一份边界判定；分成两份实现时，**弱的那份就是实际安全水位**。
import * as path from "node:path";

import { ProjectError } from "../errors.js";

export function normalizeRel(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 判断 abs 是否落在 rootAbs 之内。必须带路径分隔符边界，否则像
 * `/project-evil/x`（兄弟目录）会被裸 `startsWith("/project")` 误判为「在内」。
 */
export function isInsideRoot(rootAbs: string, abs: string): boolean {
  if (abs === rootAbs) return true;
  const boundary = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  return abs.startsWith(boundary);
}

export function toAbs(root: string, relOrAbs: string): string {
  const abs = path.resolve(root, relOrAbs);
  const rootAbs = path.resolve(root);
  if (!isInsideRoot(rootAbs, abs)) {
    throw new ProjectError("PERMISSION_DENIED", `路径越出工作区根目录：${relOrAbs}`);
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
