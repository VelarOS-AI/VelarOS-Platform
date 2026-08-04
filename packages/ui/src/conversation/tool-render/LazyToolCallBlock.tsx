import { lazy } from "react";

import type { ToolCallBlock } from "./ToolCallBlock";

type ToolCallBlockModule = {
  ToolCallBlock: typeof ToolCallBlock;
};

let toolCallBlockModulePromise: Nullable<Promise<ToolCallBlockModule>> = null;
let toolCallBlockModuleLoaded = false;

function loadToolCallBlockModule(): Promise<ToolCallBlockModule> {
  toolCallBlockModulePromise ??= import("./ToolCallBlock")
    .then((module) => {
      toolCallBlockModuleLoaded = true;
      return module;
    })
    .catch((error: unknown) => {
      toolCallBlockModulePromise = null;
      throw error;
    });

  return toolCallBlockModulePromise;
}

const LazyToolCallBlock = lazy(async () =>
  loadToolCallBlockModule().then((module) => ({
    default: module.ToolCallBlock,
  })),
);

function preloadToolCallBlock(): Promise<void> {
  return loadToolCallBlockModule().then(() => undefined);
}

function isToolCallBlockLoaded(): boolean {
  return toolCallBlockModuleLoaded;
}

export { isToolCallBlockLoaded, LazyToolCallBlock, preloadToolCallBlock };
