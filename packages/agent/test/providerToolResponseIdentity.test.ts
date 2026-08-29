import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, test } from "bun:test";

import { AppError } from "@velaros-ai/core/error";

import { ProviderTurnRequestHelper } from "../src/agent/ProviderTurnRequestHelper";
import { StreamConsumer } from "../src/agent/stream";

function providerToolStream(
  toolName: string,
): AsyncIterable<TextStreamPart<ToolSet>> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "tool-call",
        toolCallId: "call-1",
        toolName,
        input: { path: "src/index.ts" },
      } as TextStreamPart<ToolSet>;
      yield {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: {},
      } as TextStreamPart<ToolSet>;
    },
  };
}

function providerToolParts(
  parts: Array<TextStreamPart<ToolSet>>,
): AsyncIterable<TextStreamPart<ToolSet>> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* parts;
    },
  };
}

async function consumeProviderParts(
  parts: Array<TextStreamPart<ToolSet>>,
): Promise<{
  assistantContent: Awaited<ReturnType<StreamConsumer["consumeAssistantStream"]>>;
  emittedReasoning: string;
  emittedText: string;
  enqueued: string[];
}> {
  const enqueued: string[] = [];
  let emittedReasoning = "";
  let emittedText = "";
  const consumer = new StreamConsumer({
    get: () => ({}),
    getDescriptor: () => null,
  } as never);
  const assistantContent = await consumer.consumeAssistantStream(
    providerToolParts(parts),
    {
      turn: 1,
      hasToolUse: false,
      accumulatedText: "",
      hasVisibleOutput: false,
    },
    {
      abortSignal: new AbortController().signal,
      executor: {
        enqueue: (_id, toolName) => {
          enqueued.push(toolName);
        },
      },
      events: {
        emitReasoningDelta: ({ text }) => {
          emittedReasoning += text;
        },
        emitTextDelta: (text) => {
          emittedText += text;
        },
        emitGeneratedFile: () => undefined,
        emitSource: () => undefined,
        emitToolStart: () => undefined,
      },
      model: "provider-model",
      providerToCanonicalToolNames: { project__read: "project:read" },
      toolContext: {},
    },
  );

  return { assistantContent, emittedReasoning, emittedText, enqueued };
}

async function consumeToolName(
  providerToolName: string,
  providerToCanonicalToolNames: Readonly<Record<string, string>>,
  knownProviderToCanonicalToolNames: Readonly<Record<string, string>> = {},
): Promise<{
  assistantToolName: string;
  enqueuedToolName: string;
  requestAdvertised: boolean;
}> {
  const enqueuedToolNames: string[] = [];
  const requestAdvertised: boolean[] = [];
  const consumer = new StreamConsumer({
    get: (toolName: string) => (toolName === "project:read" ? {} : null),
    getDescriptor: () => null,
  } as never);
  const assistantContent = await consumer.consumeAssistantStream(
    providerToolStream(providerToolName),
    {
      turn: 1,
      hasToolUse: false,
      accumulatedText: "",
      hasVisibleOutput: false,
    },
    {
      abortSignal: new AbortController().signal,
      executor: {
        enqueue: (
          _toolCallId,
          toolName,
          _input,
          _isConcurrencySafe,
          authorization,
        ) => {
          enqueuedToolNames.push(toolName);
          requestAdvertised.push(authorization?.requestAdvertised ?? true);
        },
      },
      events: {
        emitReasoningDelta: () => undefined,
        emitTextDelta: () => undefined,
        emitGeneratedFile: () => undefined,
        emitSource: () => undefined,
        emitToolStart: () => undefined,
      },
      model: "provider-model",
      providerToCanonicalToolNames,
      // Simulate mutable ToolContext state already advancing to another projection. The response
      // must still decode with the immutable map captured for its own request.
      toolContext: {
        resolveCurrentVisibleCanonicalToolName: () => null,
        resolveKnownCanonicalToolName: (name) =>
          knownProviderToCanonicalToolNames[name] ?? null,
      },
    },
  );

  const assistantToolCall = assistantContent.find(
    (part) => part.type === "tool-call",
  );
  if (!assistantToolCall || assistantToolCall.type !== "tool-call") {
    throw new Error("expected an assistant tool call");
  }
  return {
    assistantToolName: assistantToolCall.toolName,
    enqueuedToolName: enqueuedToolNames[0] ?? "",
    requestAdvertised: requestAdvertised[0] ?? true,
  };
}

void describe("provider response tool identity", () => {
  void test("decodes a provider alias with the matching immutable request plan", async () => {
    expect(
      await consumeToolName("project__read", { project__read: "project:read" }),
    ).toEqual({
      assistantToolName: "project:read",
      enqueuedToolName: "project:read",
      requestAdvertised: true,
    });
  });

  void test("canonicalizes provider aliases in streamed visible text and persisted history", async () => {
    const result = await consumeProviderParts([
      {
        type: "text-delta",
        id: "text-1",
        text: "已使用 project__",
      } as TextStreamPart<ToolSet>,
      {
        type: "text-delta",
        id: "text-1",
        text: "read 完成。",
      } as TextStreamPart<ToolSet>,
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {},
      } as TextStreamPart<ToolSet>,
    ]);

    expect(result.emittedText).toBe("已使用 project:read 完成。");
    expect(result.assistantContent).toContainEqual({
      type: "text",
      text: "已使用 project:read 完成。",
    });
  });

  void test("canonicalizes provider aliases in streamed reasoning and persisted history", async () => {
    const result = await consumeProviderParts([
      {
        type: "reasoning-delta",
        id: "reasoning-1",
        text: "I should call project__",
      } as TextStreamPart<ToolSet>,
      {
        type: "reasoning-delta",
        id: "reasoning-1",
        text: "read next.",
      } as TextStreamPart<ToolSet>,
      {
        type: "text-delta",
        id: "text-1",
        text: "Done.",
      } as TextStreamPart<ToolSet>,
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {},
      } as TextStreamPart<ToolSet>,
    ]);

    expect(result.emittedReasoning).toBe("I should call project:read next.");
    expect(result.assistantContent).toContainEqual({
      type: "reasoning",
      text: "I should call ",
    });
    expect(
      result.assistantContent
        .filter((part) => part.type === "reasoning")
        .map((part) => part.text)
        .join(""),
    ).toBe("I should call project:read next.");
  });

  void test("canonicalizes provider aliases recovered from raw reasoning", async () => {
    const result = await consumeProviderParts([
      {
        type: "raw",
        rawValue: {
          choices: [{ delta: { reasoning_content: "Use project__read." } }],
        },
      } as TextStreamPart<ToolSet>,
      {
        type: "text-delta",
        id: "text-1",
        text: "Done.",
      } as TextStreamPart<ToolSet>,
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {},
      } as TextStreamPart<ToolSet>,
    ]);

    expect(result.emittedReasoning).toBe("Use project:read.");
    expect(result.assistantContent).toContainEqual({
      type: "reasoning",
      text: "Use project:read.",
    });
  });

  void test("keeps an already canonical provider response idempotent", async () => {
    expect(
      await consumeToolName("project:read", { project__read: "project:read" }),
    ).toEqual({
      assistantToolName: "project:read",
      enqueuedToolName: "project:read",
      requestAdvertised: true,
    });
  });

  void test("does not guess an alias that this request never advertised", async () => {
    expect(await consumeToolName("project__write", {})).toEqual({
      assistantToolName: "project__write",
      enqueuedToolName: "project__write",
      requestAdvertised: false,
    });
  });

  void test("canonicalizes a known but unadvertised transport name without authorizing it", async () => {
    expect(
      await consumeToolName(
        "project__read",
        {},
        { project__read: "project:read" },
      ),
    ).toEqual({
      assistantToolName: "project:read",
      enqueuedToolName: "project:read",
      requestAdvertised: false,
    });
  });

  void test("rejects a registered canonical tool that this request did not advertise", async () => {
    expect(
      await consumeToolName("context:recall", {
        project__read: "project:read",
      }),
    ).toEqual({
      assistantToolName: "context:recall",
      enqueuedToolName: "context:recall",
      requestAdvertised: false,
    });
  });

  void test("rejects a final tool call with no name before history or execution", async () => {
    let error: unknown;
    try {
      await consumeProviderParts([
        {
          type: "tool-call",
          toolCallId: "call-empty-name",
          toolName: "",
          input: { path: "src/index.ts" },
        } as TextStreamPart<ToolSet>,
      ]);
    } catch (caught) {
      error = caught;
    }

    const appError = AppError.from(error);
    expect(appError.code).toBe("MODEL_STREAM_INTERRUPTED");
    expect(appError.context?.reason).toBe("final_tool_name_missing");
  });

  void test("rejects a streamed tool-input start with no name", async () => {
    let error: unknown;
    try {
      await consumeProviderParts([
        {
          type: "tool-input-start",
          id: "call-empty-start-name",
          toolName: "",
        } as TextStreamPart<ToolSet>,
      ]);
    } catch (caught) {
      error = caught;
    }

    const appError = AppError.from(error);
    expect(appError.code).toBe("MODEL_STREAM_INTERRUPTED");
    expect(appError.context?.reason).toBe("tool_input_start_name_missing");
  });

  void test("recovers a blank final name only from the same completed named stream draft", async () => {
    const result = await consumeProviderParts([
      {
        type: "tool-input-start",
        id: "call-stream-name",
        toolName: "project__read",
      } as TextStreamPart<ToolSet>,
      {
        type: "tool-input-delta",
        id: "call-stream-name",
        delta: '{"path":"src/index.ts"}',
      } as TextStreamPart<ToolSet>,
      {
        type: "tool-input-end",
        id: "call-stream-name",
      } as TextStreamPart<ToolSet>,
      {
        type: "tool-call",
        toolCallId: "call-stream-name",
        toolName: "",
        input: { path: "src/index.ts" },
      } as TextStreamPart<ToolSet>,
      {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: {},
      } as TextStreamPart<ToolSet>,
    ]);

    expect(result.enqueued).toEqual(["project:read"]);
    expect(result.assistantContent).toContainEqual({
      type: "tool-call",
      toolCallId: "call-stream-name",
      toolName: "project:read",
      input: { path: "src/index.ts" },
    });
  });

  void test("does not turn historical tool calls into the next request tool surface", () => {
    const helper = new ProviderTurnRequestHelper({} as never, "stream");
    const plan = helper.resolveProviderToolNamePlan(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "historical-call",
              toolName: "project:read",
              input: { path: "src/index.ts" },
            },
          ],
        },
      ],
      ["tooling:map"],
    );

    expect(plan.providerToolNames).toEqual(["tooling:map"]);
    expect(plan.historyToolNames).toContain("project:read");

    const transportPlan = helper.captureToolTransportPlan({
      getCurrentVisibleToolTransportNames: () => ({
        "tooling:map": "tooling__map",
      }),
    });
    const requestAliases = helper.resolveProviderRequestToolNameAliases(
      transportPlan,
      plan.historyToolNames,
    );
    expect(requestAliases["project:read"]).toBe("project__read");
    expect(transportPlan.providerToCanonical.project__read).toBeUndefined();
  });
});
