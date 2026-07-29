import { isFalse } from '@velaros-ai/core'

import { createWorkspace, type CreateWorkspaceOptions, type Workspace } from "../core/workspace.js";
import { typescriptPlugin } from "../plugins/typescript/index.js";
import { validationPlugin } from "../plugins/validation.js";
import type { WorkspacePlugin } from "../types/plugin.js";

export interface RecommendedWorkspaceOptions extends CreateWorkspaceOptions {
  jsTs?: boolean;
  extraPlugins?: WorkspacePlugin[];
}

export async function createRecommendedWorkspace(options: RecommendedWorkspaceOptions): Promise<Workspace> {
  const plugins = [
    ...(options.plugins ?? []),
    ...(isFalse(options.jsTs) ? [] : [typescriptPlugin()]),
    validationPlugin(),
    ...(options.extraPlugins ?? []),
  ];
  return createWorkspace({ ...options, plugins });
}
