import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const paneStyles = readFileSync(
  new URL(
    "../../packages/ui/src/conversation/shell/ChatConversationPane.module.css",
    import.meta.url,
  ),
  "utf8",
);
const messageStyles = readFileSync(
  new URL(
    "../../packages/ui/src/conversation/blocks/MessageBubble.module.css",
    import.meta.url,
  ),
  "utf8",
);
const fileChangeStyles = readFileSync(
  new URL(
    "../../packages/ui/src/conversation/tool-render/fileChange/FileChangeToolRender.module.css",
    import.meta.url,
  ),
  "utf8",
);
const productStyles = readFileSync(
  new URL(
    "../../packages/ui/src/styles/components/product.css",
    import.meta.url,
  ),
  "utf8",
);

void describe("shared conversation content width", () => {
  void test("reserves the navigator lane at the content-column boundary", () => {
    // 只有主聊天页留导航槽位：它有 48rem 阅读栏外的留白可用。侧边形态一旦也留，
    // 窄面板会被再切掉 84px，正文与工具卡右侧空出一整条——导航条在那里改为覆盖式。
    assert.match(
      paneStyles,
      /\.conversationBody\[data-scroll-navigator-hidden='false'\] \.messageListInner:not\(\.messageListInnerSide\)\s*\{\s*padding-inline-end: 5\.25rem;/u,
    );
    assert.doesNotMatch(
      paneStyles,
      /\.conversationBody\[data-scroll-navigator-hidden='false'\] \.messageListInnerSide\s*\{/u,
    );
    assert.match(
      paneStyles,
      /\.messageSequence\s*\{\s*@apply flex min-w-0 max-w-full w-full/u,
    );
    assert.match(
      paneStyles,
      /\.streamSlot\s*\{\s*@apply flex w-full min-w-0 max-w-full/u,
    );
  });

  void test("fills that column with prose, rich blocks, and tool cards", () => {
    assert.match(
      messageStyles,
      /\.assistantRow\s*\{[\s\S]*?width: 100%;\s*max-width: 100%;/u,
    );
    assert.match(
      messageStyles,
      /\.textContent\s*\{[\s\S]*?width: 100%;\s*min-width: 0;\s*max-width: 100%;/u,
    );
    assert.match(
      messageStyles,
      /& \[data-streamdown='code-block'\]\s*\{[\s\S]*?width: 100%;\s*min-width: 0;\s*max-width: 100%;/u,
    );
    assert.match(
      messageStyles,
      /& \.expandableCodeBlock\s*\{[\s\S]*?width: 100%;\s*min-width: 0;\s*max-width: 100%;/u,
    );
    assert.match(
      messageStyles,
      /& \[data-streamdown='table-wrapper'\]\s*\{[\s\S]*?width: 100%;\s*min-width: 0;\s*max-width: 100%;/u,
    );
    assert.match(
      messageStyles,
      /\.toolActivityDisclosure\s*\{[\s\S]*?width: 100%;\s*max-width: 100%;/u,
    );
    assert.match(
      fileChangeStyles,
      /\.batchEditCard\.batchEditCard\s*\{\s*width: 100%;\s*max-width: 100%;\s*min-width: 0;/u,
    );
    assert.match(
      fileChangeStyles,
      /\.singleFileChangeList\s*\{\s*width: 100%;\s*max-width: 100%;\s*min-width: 0;/u,
    );
    assert.match(
      productStyles,
      /\.velar-tool-disclosure-card\s*\{[\s\S]*?width: 100%;\s*min-width: 0;\s*max-width: 100%;/u,
    );
  });
});
