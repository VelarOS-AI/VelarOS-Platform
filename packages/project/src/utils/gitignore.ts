/**
 * .gitignore 规则：读取、解析成 glob 规则，按「最后一条命中的规则说了算」判定一个路径是否被忽略。
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { isEmpty } from '@velaros-ai/core'

import type { GitignoreRule } from '../types/files.js'

import { matchesAny } from "./glob.js";
import { normalizeRel } from "./path.js";

/** 规整一行 .gitignore：去掉行尾的 CR 和没转义的尾随空格，还原 \ 空格、\#、\! 这几种转义。 */
function normalizeGitignoreLine(line: string): string {
  let value = line.replace(/\r$/, "");
  while (value.endsWith(" ") && !value.endsWith("\\ ")) {
    value = value.slice(0, -1);
  }
  return value
    .replace(/\\ /g, " ")
    .replace(/\\#/g, "#")
    .replace(/\\!/g, "!");
}

/** 每条规则再配一条「它下面的一切」（pattern/**），忽略目录时连带忽略其中的全部内容。 */
function addDescendantPatterns(patterns: string[]): string[] {
  const expanded: string[] = [];
  for (const pattern of patterns) {
    expanded.push(pattern);
    expanded.push(`${pattern}/**`);
  }
  return expanded;
}

/** 把规则接到 .gitignore 所在目录下面；在项目根时原样返回。 */
function withBase(baseRel: string, pattern: string): string {
  return normalizeRel(baseRel ? `${baseRel}/${pattern}` : pattern);
}

/** 把一条 .gitignore 规则展开成相对项目根的 glob：以 / 开头或含 / 的只在所在目录下匹配，其余在任意层级匹配，都连带其下全部内容。 */
function buildPatterns(pattern: string, baseRel: string): string[] {
  const anchored = pattern.startsWith("/");
  const body = normalizeRel(pattern.replace(/^\/+/, ""));
  if (!body) return [];

  if (anchored || body.includes("/")) return addDescendantPatterns([withBase(baseRel, body)]);

  const unanchored = baseRel
    ? [withBase(baseRel, body), withBase(baseRel, `**/${body}`)]
    : [body, `**/${body}`];
  return addDescendantPatterns(unanchored);
}

/** 解析一份 .gitignore 的正文：跳过空行与注释，! 开头的是反向规则，baseRel 是这份文件所在目录（相对项目根）。 */
export function parseGitignore(content: string, baseRel = ""): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  const normalizedBase = normalizeRel(baseRel).replace(/\/$/, "");

  for (const rawLine of content.split("\n")) {
    let line = normalizeGitignoreLine(rawLine).trimStart();
    if (!line || line.startsWith("#")) continue;

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }

    const pattern = line.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!pattern) continue;

    const patterns = buildPatterns(pattern, normalizedBase);
    if (isEmpty(patterns)) continue;
    rules.push({ negated, patterns });
  }

  return rules;
}

/** 读 dirRel 目录下那份 .gitignore 并解析；没有这个文件或读不了时当作没有规则。 */
export async function readGitignoreRules(rootAbs: string, dirRel: string): Promise<GitignoreRule[]> {
  const normalizedDirRel = normalizeRel(dirRel).replace(/\/$/, "");
  const gitignorePath = path.join(rootAbs, normalizedDirRel, ".gitignore");
  try {
    const content = await readFile(gitignorePath, "utf8");
    return parseGitignore(content, normalizedDirRel === "." ? "" : normalizedDirRel);
  } catch {
    // arch-guard:silent-catch-ok 缺少 .gitignore 或读取失败时按无规则处理。
    return [];
  }
}

/**
 * 根目录到 `dirRel` 父目录逐级累积的规则（不含 `dirRel` 自己的 .gitignore）。从子目录开始遍历
 * 时先带上它们，`dirRel` 及其后代的判定才与从根目录一路遍历下来一致。
 */
export async function readAncestorGitignoreRules(rootAbs: string, dirRel: string): Promise<GitignoreRule[]> {
  const segments = normalizeRel(dirRel).split("/").filter((segment) => segment && segment !== ".");
  const rules: GitignoreRule[] = [];
  for (let depth = 0; depth < segments.length; depth += 1) {
    rules.push(...(await readGitignoreRules(rootAbs, segments.slice(0, depth).join("/"))));
  }
  return rules;
}

/** 按顺序套用规则判断路径是否被忽略：最后一条命中的规则说了算，反向规则命中就不忽略。 */
export function isGitignored(pathRel: string, rules: readonly GitignoreRule[]): boolean {
  const normalizedPath = normalizeRel(pathRel).replace(/\/$/, "");
  let ignored = false;

  for (const rule of rules) {
    if (matchesAny(normalizedPath, rule.patterns)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}
