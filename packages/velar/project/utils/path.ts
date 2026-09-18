// 域：工作区根目录约束的路径原语（词法归一 + 根内判定）。
//
// **安全门（改这里要想清楚）**：工作区的「不许越出 root」是**两层**门，两层都长在本文件的
// `isInsideRoot` 上：
//   1. **词法层** `toAbs`：`path.resolve` 归一后比边界，拦 `../../etc/passwd` 这类穿越；
//   2. **符号链接层** `FileStore.authorize`：对 realpath 解析后的真实路径再比一次，拦
//      「root 内的软链指向 root 外」。只有第 1 层时，一个 `ln -s / root/escape` 就能读全盘。
// 两层必须共用同一份边界判定；分成两份实现时，**弱的那份就是实际安全水位**。
import * as path from "node:path";

import { currentPlatform } from '@velaros-ai/platform'

import { ProjectError } from "./errors.js";

/** 把路径里的反斜杠换成 /，去掉开头的 ./。 */
export function normalizeRel(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 判断 abs 是否落在 rootAbs 之内（含根本身）。判定交给 platform 的路径文本包含判断：它带分隔符边界（`/project-evil/x`
 * 这种兄弟目录不算在内）、折叠 `.` 与 `..`、名字以 `..` 开头的目录照常算在里面。两端都按字面比大小写：进这里的路径要么
 * 已经 `path.resolve` 过、要么是 realpath 的结果，盘上的写法是什么就是什么。
 */
export function isInsideRoot(rootAbs: string, abs: string): boolean {
  return currentPlatform.isPathTextInside(abs, rootAbs, { caseSensitive: true });
}

/** 把相对 root 的路径（或绝对路径）解析成绝对路径；越出 root 就抛 PERMISSION_DENIED。这是根内约束的词法那一层。 */
export function toAbs(root: string, relOrAbs: string): string {
  const abs = path.resolve(root, relOrAbs);
  const rootAbs = path.resolve(root);
  if (!isInsideRoot(rootAbs, abs)) {
    throw new ProjectError("PERMISSION_DENIED", `路径出了当前项目：${relOrAbs}`);
  }
  return abs;
}

/** 把路径换成相对 root 的写法，分隔符统一成 /。不检查是否越出 root。 */
export function toRel(root: string, absOrRel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(root, absOrRel);
  return normalizeRel(path.relative(rootAbs, abs));
}

/** 取小写的扩展名（带点，如 .ts）；没有扩展名时是空串。 */
export function ext(input: string): string {
  return path.extname(input).toLowerCase();
}

/** 取路径的父目录。 */
export function dirname(input: string): string {
  return path.dirname(input);
}
