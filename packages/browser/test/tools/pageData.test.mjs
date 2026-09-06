/**
 * @test-meta
 * title: 浏览器页面读取与脚本执行能力分离
 * summary: 受控页面数据读取保持 read 契约，任意 JavaScript 继续使用 external 契约。
 * area: packages
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const packagePath = new URL("../../dist/tools/index.js", import.meta.url);

test("controlled page data presets are read-only and arbitrary script execution is external", async () => {
  const { browserTools } = await import(packagePath.href);
  const readPageData = browserTools["browser:read_page_data"];
  const evaluateScript = browserTools["browser:evaluate_script"];

  assert.equal(readPageData.capabilities.effectKind, "read");
  assert.equal(readPageData.role, "inspect");
  assert.equal(readPageData.isConcurrencySafe(), true);
  assert.equal(evaluateScript.capabilities.effectKind, "external");
  assert.equal(evaluateScript.role, "control");
  assert.equal(evaluateScript.isConcurrencySafe(), false);
  assert.equal(evaluateScript.surfaces, undefined);
});

test("controlled page data execution only forwards owner-generated scripts", async () => {
  const { browserTools } = await import(packagePath.href);
  let forwarded;
  const result = await browserTools["browser:read_page_data"].execute(
    { preset: "body_text", maxChars: 120 },
    {
      abortSignal: { throwIfAborted() {} },
      browser: {
        isActive: () => true,
        evaluateScript: async (input) => {
          forwarded = input;
          return { ok: true };
        },
      },
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(forwarded.mode, "function-body");
  assert.match(forwarded.script, /text\.slice\(0, 120\)/u);
  assert.equal("preset" in forwarded, false);
});

test("controlled selector data is encoded as inert JavaScript source", async () => {
  const { browserTools } = await import(packagePath.href);
  let forwarded;
  const selector = `a');globalThis.pwned=true;//\n\u2028${'`'}${'${alert(1)}'}`;

  await browserTools["browser:read_page_data"].execute(
    { preset: "selector_count", selector },
    {
      abortSignal: { throwIfAborted() {} },
      browser: {
        isActive: () => true,
        evaluateScript: async (input) => {
          forwarded = input;
          return { count: 0 };
        },
      },
    },
  );

  assert.equal(forwarded.script.includes(selector), false);
  assert.equal(forwarded.script.includes("globalThis.pwned"), false);
  const functionBody = new Function("document", forwarded.script);
  assert.deepEqual(functionBody({ querySelectorAll: (received) => {
    assert.equal(received, selector);
    return [];
  } }), { count: 0 });
});
