import { type AgentToolDefinition, createAgentTools } from "../agent-tools.js";
import { WORKSPACE_PACKAGE_VERSION } from "../core/defaults.js";
import { createWorkspace, type CreateWorkspaceOptions, type Workspace } from "../core/workspace.js";
import { createMcpLikeServer, type McpLikeServer } from "../mcp/index.js";
import { createWorkspaceToolSchemaBundle, type WorkspaceToolSchemaBundle } from "../tool-schema.js";
import type { WorkspacePlugin } from "../types/plugin.js";
import type { WorkspaceProviders } from "../types/provider.js";
export type { ApprovalExecutionContext } from "./approval-context.js";
export { installApprovalProvider, withApprovalContext } from "./approval-context.js";

export interface VelarosLikeRuntime {
  context?: WorkspaceProviders["context"];
  policy?: WorkspaceProviders["policy"];
  approval?: WorkspaceProviders["approval"];
  fileFilter?: WorkspaceProviders["fileFilter"];
  secretRedaction?: WorkspaceProviders["secretRedaction"];
  command?: WorkspaceProviders["command"];
  telemetry?: WorkspaceProviders["telemetry"];
  sandbox?: WorkspaceProviders["sandbox"];
  logger?: WorkspaceProviders["logger"];
  codeIntelligence?: WorkspaceProviders["codeIntelligence"];
  tools?: {
    register?(tool: AgentToolDefinition, metadata?: VelarosWorkspaceToolRegistrationMetadata): void | Promise<void>;
    registerMany?(tools: AgentToolDefinition[], metadata?: VelarosWorkspaceToolRegistrationMetadata): void | Promise<void>;
  };
  modules?: {
    register?(module: VelarosWorkspaceModule): void | Promise<void>;
  };
}

export interface CreateVelarosWorkspaceOptions extends Omit<CreateWorkspaceOptions, "providers"> {
  velaros?: VelarosLikeRuntime;
  providers?: WorkspaceProviders;
  autoRegisterTools?: boolean;
  plugins?: WorkspacePlugin[];
}

export interface VelarosWorkspaceBridge {
  workspace: Workspace;
  tools: AgentToolDefinition[];
  toolSchemaBundle: WorkspaceToolSchemaBundle;
  mcp: McpLikeServer;
  registerTools(): Promise<void>;
  asModule(): VelarosWorkspaceModule;
}

export interface VelarosWorkspaceToolRegistrationMetadata {
  schemaBundle: WorkspaceToolSchemaBundle;
}

export interface VelarosWorkspaceModule {
  name: "workspace";
  version: string;
  workspace: Workspace;
  tools: AgentToolDefinition[];
  toolSchemaBundle: WorkspaceToolSchemaBundle;
  mcp: McpLikeServer;
  dispose?(): Promise<void> | void;
}

function mergeProviders(runtime?: VelarosLikeRuntime, explicit?: WorkspaceProviders): WorkspaceProviders {
  return {
    context: explicit?.context ?? runtime?.context,
    policy: explicit?.policy ?? runtime?.policy,
    approval: explicit?.approval ?? runtime?.approval,
    fileFilter: explicit?.fileFilter ?? runtime?.fileFilter,
    secretRedaction: explicit?.secretRedaction ?? runtime?.secretRedaction,
    command: explicit?.command ?? runtime?.command,
    telemetry: explicit?.telemetry ?? runtime?.telemetry,
    sandbox: explicit?.sandbox ?? runtime?.sandbox,
    logger: explicit?.logger ?? runtime?.logger,
    codeIntelligence: explicit?.codeIntelligence ?? runtime?.codeIntelligence,
  };
}

export async function createVelarosWorkspaceBridge(options: CreateVelarosWorkspaceOptions): Promise<VelarosWorkspaceBridge> {
  const velaros = options.velaros;
  const providers = mergeProviders(velaros, options.providers);
  const workspace = await createWorkspace({ ...options, providers });
  const tools = createAgentTools(workspace);
  const toolSchemaBundle = createWorkspaceToolSchemaBundle(tools);
  const toolRegistrationMetadata: VelarosWorkspaceToolRegistrationMetadata = { schemaBundle: toolSchemaBundle };
  const mcp = createMcpLikeServer(workspace, { tools, schemaBundle: toolSchemaBundle });
  const module: VelarosWorkspaceModule = {
    name: "workspace",
    version: WORKSPACE_PACKAGE_VERSION,
    workspace,
    tools,
    toolSchemaBundle,
    mcp,
  };
  let toolsRegistered = false;
  async function registerTools(): Promise<void> {
    if (toolsRegistered) return;
    if (velaros?.tools?.registerMany) await velaros.tools.registerMany(tools, toolRegistrationMetadata);
    else if (velaros?.tools?.register) for (const tool of tools) await velaros.tools.register(tool, toolRegistrationMetadata);
    toolsRegistered = true;
  }
  function asModule(): VelarosWorkspaceModule {
    return module;
  }
  if (options.autoRegisterTools) await registerTools();
  await velaros?.modules?.register?.(module);
  return { workspace, tools, toolSchemaBundle, mcp, registerTools, asModule };
}

export async function createVelarosWorkspace(options: CreateVelarosWorkspaceOptions): Promise<Workspace> {
  return (await createVelarosWorkspaceBridge(options)).workspace;
}
