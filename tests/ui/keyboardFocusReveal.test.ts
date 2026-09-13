import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const uiSource = fileURLToPath(new URL("../../packages/ui/src", import.meta.url));

function listStylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listStylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

function readStyles(path: string): string {
  return readFileSync(join(uiSource, path), "utf8");
}

/**
 * `:focus-within` 只留给输入类控件：打字本来就要焦点，它们用它画外框。悬停才出现的操作按钮、悬停
 * 高亮跟着键盘焦点（`:focus-visible`）走——鼠标点过的按钮会一直留着焦点，用 `:focus-within` 的话点完
 * 移开也不消失。
 */
const FocusWithinAllowed = new Set([
  "styles/components/primitives/number-input.css",
  "styles/components/primitives/search-field.css",
  "styles/components/primitives/time-picker.css",
]);

void describe("keyboard focus reveal", () => {
  void test("only input controls react to :focus-within", () => {
    const offenders = listStylesheets(uiSource)
      .map((path) => relative(uiSource, path))
      .filter((path) => !FocusWithinAllowed.has(path))
      .filter((path) =>
        readStyles(path)
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .includes(":focus-within"),
      );

    assert.deepEqual(offenders, []);
  });

  void test("a file row shows its actions on hover or keyboard focus, not after a click", () => {
    const styles = readStyles("conversation/cards/FileChangeSummaryList.module.css");

    assert.match(
      styles,
      /\.fileButton:hover \.fileActions,\s*\.fileButton:has\(:focus-visible\) \.fileActions \{/u,
    );
  });

  void test("buttons that clear their shadow give the focus ring back on keyboard focus", () => {
    assert.match(
      readStyles("styles/components/primitives/button.css"),
      /\.velar-button:focus-visible \{\s*box-shadow: var\(--ui-shadow-focus-ring\);/u,
    );
    assert.match(
      readStyles("conversation/composer/ChatInput.module.css"),
      /\.toolbarRight :global\(\.velar-button-size-icon-sm:focus-visible\) \{\s*box-shadow: var\(--ui-shadow-focus-ring\);/u,
    );
    assert.match(
      readStyles("conversation/composer/ChatInput.module.css"),
      /\.composerModelRunSelectorButton:is\(:hover, \[data-open='true'\]\):not\(:focus-visible\) \{\s*box-shadow: none;/u,
    );
    assert.match(
      readStyles("conversation/cards/FileChangeSummaryList.module.css"),
      /\.fileActionButton\.fileActionButton:focus-visible \{\s*box-shadow: var\(--ui-shadow-focus-ring\);/u,
    );
    assert.match(
      readStyles("conversation/tool-render/fileChange/FileChangeToolRender.module.css"),
      /\.actionIconButton\.actionIconButton:focus-visible \{\s*box-shadow: var\(--ui-shadow-focus-ring\);/u,
    );
  });
});
