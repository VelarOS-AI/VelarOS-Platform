import { structuredPatch } from "diff";

import { isEmpty } from '@velaros-ai/core'

/**
 * 生成标准 unified diff。
 *
 * 历史实现用「最长公共前缀 + 最长公共后缀 + 中间整块替换」近似，多段编辑会被错误地折成一个超大 hunk。
 * 这里改用 `diff` 包的 `structuredPatch`，输出真正的多 hunk Myers diff，与 `git diff` 行为一致，
 * 让 AI agent 与 UI 都能更准确地理解局部修改的位置与代价。
 *
 * 输出格式（行尾无换行，让 `combineDiffs` 用 "\n" 连接时自然形成空行分隔）：
 *
 * ```
 * --- a/path
 * +++ b/path
 * @@ -<oldStart>,<oldLines> +<newStart>,<newLines> @@
 *  context
 * -removed
 * +added
 *  context
 * @@ -<oldStart>,<oldLines> +<newStart>,<newLines> @@
 * ...
 * ```
 */
export function unifiedDiff(path: string, oldContent = "", newContent = ""): string {
  if (oldContent === newContent) return "";

  const patch = structuredPatch(path, path, oldContent, newContent, "", "", { context: 3 });
  if (isEmpty(patch.hunks)) return "";

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of patch.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

export function combineDiffs(diffs: string[]): string {
  return diffs.filter(Boolean).join("\n");
}
