import type { ToolDescriptionDetail } from "@velaros-ai/core/utils/ToolDescription";

import { type AgentToolDefinition, createAgentTools,type CreateAgentToolsOptions } from "../agent-tools.js";
import type { WorkspaceKernel } from "../core/workspace.js";
import { WorkspaceError } from "../errors.js";
import {
  createWorkspaceToolSchemaBundle,
  schemaToInputSchema,
  type WorkspaceToolSchemaBundle,
} from "../tool-schema.js";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface McpLikeServer {
  listTools(): WorkspaceToolSchemaBundle;
  listExpandedTools(): McpToolDescriptor[];
  callTool(name: string, args?: any): Promise<any>;
}

/** 将 agent tool 暴露为 MCP 风格 descriptor，供轻量宿主集成。 */
export function createMcpTools(
  workspace: WorkspaceKernel,
  options: CreateAgentToolsOptions = {}
): McpToolDescriptor[] {
  return createAgentTools(workspace, options).map(({ name, description, schema }) => ({
    name,
    description,
    inputSchema: schemaToInputSchema(schema),
  }));
}

export interface CreateMcpLikeServerOptions {
  tools?: AgentToolDefinition[];
  schemaBundle?: WorkspaceToolSchemaBundle;
  /** 工具描述详细程度（L4）；仅在未显式传入 tools/schemaBundle 时生效。 */
  detail?: ToolDescriptionDetail;
}

function toMcpToolDescriptors(tools: Iterable<AgentToolDefinition>): McpToolDescriptor[] {
  return [...tools].map(({ name, description, schema }) => ({
    name,
    description,
    inputSchema: schemaToInputSchema(schema),
  }));
}

export function createMcpLikeServer(
  workspace: WorkspaceKernel,
  options: CreateMcpLikeServerOptions = {}
): McpLikeServer {
  const agentTools = options.tools ?? createAgentTools(workspace, { detail: options.detail });
  const tools = new Map<string, AgentToolDefinition>(agentTools.map((tool) => [tool.name, tool]));
  const schemaBundle = options.schemaBundle ?? createWorkspaceToolSchemaBundle(agentTools);
  let expandedTools: McpToolDescriptor[] | undefined;
  return {
    listTools() {
      return schemaBundle;
    },
    listExpandedTools() {
      expandedTools ??= toMcpToolDescriptors(tools.values());
      return expandedTools;
    },
    async callTool(name: string, args?: any): Promise<any> {
      const tool = tools.get(name);
      if (!tool) throw new WorkspaceError("NOT_SUPPORTED", `未知 MCP workspace 工具：${name}`, { name });
      return tool.execute(args ?? {});
    },
  };
}
