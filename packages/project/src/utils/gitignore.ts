import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { isEmpty } from '@velaros-ai/core'

import { matchesAny } from "./glob.js";
import { normalizeRel } from "./path.js";

export interface GitignoreRule {
  negated: boolean;
  patterns: string[];
}

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

function addDescendantPatterns(patterns: string[]): string[] {
  const expanded: string[] = [];
  for (const pattern of patterns) {
    expanded.push(pattern);
    expanded.push(`${pattern}/**`);
  }
  return expanded;
}

function withBase(baseRel: string, pattern: string): string {
  return normalizeRel(baseRel ? `${baseRel}/${pattern}` : pattern);
}

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
