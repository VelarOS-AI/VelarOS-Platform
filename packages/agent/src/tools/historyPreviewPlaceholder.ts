// 历史参数占位串的唯一格式：旧调用的大参数在模型历史里压成一行带原长度、字段名与短预览的占位文本
// （见 historyPreviewPlaceholder）。生成、重放折叠（toolResultSerialization）与执行前的照抄检测（Executor）共用这一处定义；
// 本模块不进包的公开出口，格式只是模型可见文本，不是对外契约。
import { isArray, isPlainObject, isString } from "@velaros-ai/core";

// 只锚定开头：嵌套时内层 preview 被截到 160 字符，模型也会把占位头抄进真实参数后接真实内容，
// 两种情况都不以 "…]" 收尾，按整串匹配会漏掉它们，重放时又被再包一层。
export const HistoryPreviewPlaceholderHeaderPattern =
  /^\[history preview omitted (\d+) chars from ("[^"]*"|string); tool received the full value(; preview: )?/;

/** 占位串的唯一格式：`summarizeToolInputString` 生成与 `collapseHistoryPreviewPlaceholder` 重建共用。 */
export function historyPreviewPlaceholder(length: number, field: string, previewSource: string): string {
  const preview = previewSource.slice(0, 160).replaceAll(/\s+/g, " ").trim();
  return preview
    ? `[history preview omitted ${length} chars from ${field}; tool received the full value; preview: ${preview}…]`
    : `[history preview omitted ${length} chars from ${field}; tool received the full value]`;
}

const MaxPlaceholderArgumentScanDepth = 6;
const MaxPlaceholderArgumentScanNodes = 2_000;

/**
 * 找出工具参数里「以历史占位串开头」的字符串字段，返回其路径（如 `edits[0].newText`）。
 * 旧调用的大参数在历史里只剩占位串，模型偶尔会照抄这段占位当成新调用的真实内容——写进文件就是
 * 一行 "[history preview omitted …"。只认开头（容忍前导空白）：源码里以字符串字面量出现的同样
 * 文字前面总有引号或代码，不会被误判。扫描深度与节点数都有上限。
 */
export function findHistoryPreviewPlaceholderArgumentPaths(
  args: Record<string, unknown>,
): string[] {
  const paths: string[] = [];
  let visited = 0;

  const visit = (value: unknown, path: string, depth: number): void => {
    visited += 1;
    if (visited > MaxPlaceholderArgumentScanNodes) return;
    if (isString(value)) {
      if (HistoryPreviewPlaceholderHeaderPattern.test(value.trimStart()))
        paths.push(path);
      return;
    }
    if (depth >= MaxPlaceholderArgumentScanDepth) return;
    if (isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, item] of Object.entries(value))
      visit(item, path ? `${path}.${key}` : key, depth + 1);
  };

  visit(args, "", 0);
  return paths;
}
